import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import {
    LineClient,
    LineContentError,
    buildLineMessages,
    hasNamePlaceholder,
    replaceNamePlaceholder,
    toErrorMessage,
} from '@/lib/line'
import { chunk } from '@/lib/utils'
import { resolveRecipients } from '@/lib/messaging/recipients'

/**
 * メッセージ送信
 * POST /api/messages/send
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const { messageId } = await request.json()

        if (!messageId) {
            return NextResponse.json({ error: 'messageId が必要です' }, { status: 400 })
        }

        // メッセージ情報取得
        const adminClient = createAdminClient()
        const { data: message, error: messageError } = await adminClient
            .from('messages')
            .select(`
        *,
        channels (*)
      `)
            .eq('id', messageId)
            .single()

        if (messageError || !message) {
            return NextResponse.json({ error: 'メッセージが見つかりません' }, { status: 404 })
        }

        // コンテンツの変換（アクション付き画像はFlex Messageになる）
        // LINEは1つでも不正な値があるとリクエスト全体を400で弾くため、送信対象を集める前に検証する
        let lineMessages: object[]
        try {
            lineMessages = buildLineMessages(message.content, {
                postbackData: `action=custom&mid=${messageId}`,
            })
        } catch (err) {
            if (err instanceof LineContentError) {
                await adminClient
                    .from('messages')
                    .update({ status: 'failed', error_message: err.message })
                    .eq('id', messageId)

                return NextResponse.json({ error: err.message }, { status: 400 })
            }
            throw err
        }

        // 配信対象ユーザーを取得（1000件上限を避けるため全件ページング取得）
        const { recipients, error: recipientsError } = await resolveRecipients(adminClient, {
            channelId: message.channel_id,
            filterTags: message.filter_tags,
            excludeTags: message.exclude_tags,
        })

        // 対象の取得に失敗したまま送ると、一部にしか届かない/除外が効かない事故になるため中断する
        if (recipientsError) {
            console.error('配信対象の取得エラー:', recipientsError)
            await adminClient
                .from('messages')
                .update({ status: 'failed', error_message: '配信対象の取得に失敗しました' })
                .eq('id', messageId)

            return NextResponse.json({ error: '配信対象の取得に失敗しました' }, { status: 500 })
        }

        if (recipients.length === 0) {
            await adminClient
                .from('messages')
                .update({
                    status: 'sent',
                    total_recipients: 0,
                    success_count: 0,
                    failure_count: 0,
                    error_message: null,
                    sent_at: new Date().toISOString(),
                })
                .eq('id', messageId)

            return NextResponse.json({ success: true, sent: 0 })
        }

        // LINE クライアント作成
        const channel = message.channels as any
        const lineClient = new LineClient(channel.channel_access_token)

        // メッセージ送信（500人ずつバッチ処理）
        const lineUserIds = recipients.map(r => r.line_user_id)
        const batches = chunk(lineUserIds, 500)

        let successCount = 0
        let failureCount = 0
        // 失敗理由は配信履歴に残す（LINEのエラー本文がないと原因が特定できないため）
        let firstError: string | null = null

        const recordError = (error: unknown) => {
            if (!firstError) {
                firstError = toErrorMessage(error)
            }
        }

        if (hasNamePlaceholder(lineMessages)) {
            // 個別送信モード（プッシュメッセージ）
            // display_name は recipients に含まれているので再クエリしない
            const userMap = new Map(recipients.map(r => [r.line_user_id, r.display_name]))

            // 10件ずつの並列処理で送信（レートリミット対策）
            const pushBatches = chunk(lineUserIds, 10)

            for (const batch of pushBatches) {
                await Promise.all(batch.map(async (userId) => {
                    try {
                        const personalizedContent = replaceNamePlaceholder(
                            lineMessages,
                            userMap.get(userId)
                        )

                        await lineClient.pushMessage(userId, personalizedContent)
                        successCount++
                    } catch (error) {
                        console.error(`個別送信エラー (${userId}):`, error)
                        recordError(error)
                        failureCount++
                    }
                }))
            }
        } else {
            // 通常の一斉送信モード（マルチキャスト）
            for (const batch of batches) {
                try {
                    await lineClient.multicast(batch, lineMessages)
                    successCount += batch.length
                } catch (error) {
                    console.error('配信エラー:', error)
                    recordError(error)
                    failureCount += batch.length
                }
            }
        }

        // ステータス更新
        await adminClient
            .from('messages')
            .update({
                status: failureCount === recipients.length ? 'failed' : 'sent',
                total_recipients: recipients.length,
                success_count: successCount,
                failure_count: failureCount,
                error_message: firstError,
                sent_at: new Date().toISOString(),
            })
            .eq('id', messageId)

        return NextResponse.json({
            success: true,
            total: recipients.length,
            successCount,
            failureCount,
            error: firstError,
        })
    } catch (error) {
        console.error('メッセージ送信エラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
