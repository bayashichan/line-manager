import { NextRequest, NextResponse } from 'next/server'
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
import { recordBroadcastDelivery, type DeliveryOutcome } from '@/lib/messaging/delivery-log'

/**
 * QStashからのWebhook受信エンドポイント (予約配信の実行)
 * POST /api/webhook/qstash-line
 */
export async function POST(request: NextRequest) {
    const authHeader = request.headers.get('authorization')
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: '認証エラー' }, { status: 401 })
    }
    return handler(request)
}

async function handler(request: NextRequest) {
    try {
        const body = await request.json()
        const { messageId } = body

        if (!messageId) {
            console.error('QStash Webhook Error: messageId がありません')
            return NextResponse.json({ error: 'messageId missing' }, { status: 400 })
        }

        const adminClient = createAdminClient()

        // 1. メッセージ情報の取得
        const { data: message, error: messageError } = await adminClient
            .from('messages')
            .select(`*, channels (*)`)
            .eq('id', messageId)
            .single()

        if (messageError || !message) {
            console.error('QStash Webhook Error: メッセージが見つかりません', messageId)
            return NextResponse.json({ error: 'Message not found' }, { status: 404 })
        }

        // 既に送信済み/処理中の場合はスキップ
        if (message.status === 'sent' || message.status === 'sending') {
            console.log(`QStash Webhook: メッセージ ${messageId} は既に処理されています。ステータス: ${message.status}`)
            return NextResponse.json({ success: true, skipped: true })
        }

        // ステータスを送信中に更新
        await adminClient
            .from('messages')
            .update({ status: 'sending' })
            .eq('id', messageId)

        // 2. コンテンツの変換（アクション付き画像はFlex Messageになる）
        //    不正な内容は送る前に弾き、理由を配信履歴に残す
        let lineMessages: object[]
        try {
            lineMessages = buildLineMessages(message.content, {
                postbackData: `action=custom&mid=${messageId}`,
            })
        } catch (err) {
            if (err instanceof LineContentError) {
                console.error('QStash Webhook: 配信内容が不正です', err.message)
                await adminClient
                    .from('messages')
                    .update({ status: 'failed', error_message: err.message })
                    .eq('id', messageId)

                return NextResponse.json({ error: err.message }, { status: 400 })
            }
            throw err
        }

        // 3. 配信対象ユーザーの取得（1000件上限を避けるため全件ページング取得）
        const { recipients, error: recipientsError } = await resolveRecipients(adminClient, {
            channelId: message.channel_id,
            filterTags: message.filter_tags,
            excludeTags: message.exclude_tags,
        })

        // 対象の取得に失敗したまま送ると、一部にしか届かない/除外が効かない事故になるため中断する。
        // status は sending のままにせず failed に戻し、再実行できるようにする。
        if (recipientsError) {
            console.error('QStash Webhook: 配信対象の取得エラー', recipientsError)
            await adminClient
                .from('messages')
                .update({ status: 'failed', error_message: '配信対象の取得に失敗しました' })
                .eq('id', messageId)

            return NextResponse.json({ error: '配信対象の取得に失敗しました' }, { status: 500 })
        }

        if (recipients.length === 0) {
            await completeMessage(adminClient, messageId, 0, 0, 0, null)
            return NextResponse.json({ success: true, sent: 0 })
        }


        // 4. LINE APIで送信
        const channel = message.channels as any
        const lineClient = new LineClient(channel.channel_access_token)

        const lineUserIds = recipients.map(r => r.line_user_id)
        const batches = chunk(lineUserIds, 500)

        let successCount = 0
        let failureCount = 0
        let firstError: string | null = null
        // 友だちごとの結果。既読状況の一覧で「届いた人／届かなかった人」を分けるのに使う
        const outcomes = new Map<string, DeliveryOutcome>()

        const recordError = (error: unknown) => {
            if (!firstError) {
                firstError = toErrorMessage(error)
            }
        }

        if (hasNamePlaceholder(lineMessages)) {
            // 個別送信モード（display_name は recipients に含まれているので再クエリしない）
            const userMap = new Map(recipients.map(r => [r.line_user_id, r.display_name]))
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
                        outcomes.set(userId, { status: 'sent', error: null })
                    } catch (error) {
                        console.error(`個別送信エラー (${userId}):`, error)
                        recordError(error)
                        failureCount++
                        outcomes.set(userId, { status: 'failed', error: toErrorMessage(error) })
                    }
                }))
            }
        } else {
            // 一斉送信モード
            // マルチキャストは相手ごとの結果を返さないため、バッチ単位の成否を全員に割り当てる
            for (const batch of batches) {
                try {
                    await lineClient.multicast(batch, lineMessages)
                    successCount += batch.length
                    batch.forEach(userId => outcomes.set(userId, { status: 'sent', error: null }))
                } catch (error) {
                    console.error('配信エラー:', error)
                    recordError(error)
                    failureCount += batch.length
                    const detail = toErrorMessage(error)
                    batch.forEach(userId => outcomes.set(userId, { status: 'failed', error: detail }))
                }
            }
        }

        // 5. ステータス更新と完了
        // 友だちごとの記録より先に更新する。記録は行数が多く時間がかかるため、
        // 途中で打ち切られても配信履歴が「配信中」のまま止まらないようにする。
        const sentAt = new Date().toISOString()
        await completeMessage(adminClient, messageId, recipients.length, successCount, failureCount, firstError, sentAt)

        // 友だちごとの配信記録 + 1:1チャットへの反映（既読状況の集計に使う）
        await recordBroadcastDelivery(adminClient, {
            channelId: message.channel_id,
            messageId,
            recipients,
            outcomes,
            blocks: lineMessages,
            sentAt,
        })

        return NextResponse.json({ success: true, successCount, failureCount })

    } catch (error: any) {
        console.error('QStash Webhook 処理エラー:', error)
        return NextResponse.json({ error: error?.message || 'Internal Server Error' }, { status: 500 })
    }
}

// 完了時のDB更新ヘルパー
// 全員に届かなかった場合は sent にしない（予約配信が失敗しても成功に見えてしまうため）
async function completeMessage(
    adminClient: any,
    messageId: string,
    total: number,
    success: number,
    failure: number,
    errorMessage: string | null,
    sentAt: string = new Date().toISOString()
) {
    await adminClient
        .from('messages')
        .update({
            status: total > 0 && failure === total ? 'failed' : 'sent',
            total_recipients: total,
            success_count: success,
            failure_count: failure,
            error_message: errorMessage,
            sent_at: sentAt,
        })
        .eq('id', messageId)
}
