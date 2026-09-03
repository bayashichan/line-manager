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
 * 予約配信を処理するCronジョブ
 * GET /api/cron/scheduled-messages
 * 
 * Vercel Cronから定期実行される
 * vercel.json で設定:
 * {
 *   "crons": [{
 *     "path": "/api/cron/scheduled-messages",
 *     "schedule": "* * * * *"
 *   }]
 * }
 */
export async function GET(request: NextRequest) {
    try {
        // CronシークレットをチェStepク（本番環境用）
        const authHeader = request.headers.get('authorization')
        if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: '認証エラー' }, { status: 401 })
        }

        const supabase = createAdminClient()
        const now = new Date().toISOString()

        // 予約時刻を過ぎた予約中メッセージを取得
        const { data: scheduledMessages, error } = await supabase
            .from('messages')
            .select(`
        *,
        channels (*)
      `)
            .eq('status', 'scheduled')
            .lte('scheduled_at', now)
            .limit(10)

        if (error) {
            console.error('予約メッセージ取得エラー:', error)
            return NextResponse.json({ error: '取得エラー' }, { status: 500 })
        }

        if (!scheduledMessages || scheduledMessages.length === 0) {
            return NextResponse.json({ processed: 0 })
        }

        let processedCount = 0

        for (const message of scheduledMessages) {
            try {
                // ステータスを配信中に更新
                await supabase
                    .from('messages')
                    .update({ status: 'sending' })
                    .eq('id', message.id)

                const channel = message.channels as any

                // コンテンツの変換（アクション付き画像はFlex Messageになる）
                // 変換せずに送るとタップアクションが失われるうえ、管理画面用のフィールドが
                // そのままLINEに渡ってリクエストごと弾かれる
                let lineMessages: object[]
                try {
                    lineMessages = buildLineMessages(message.content, {
                        postbackData: `action=custom&mid=${message.id}`,
                    })
                } catch (err) {
                    if (err instanceof LineContentError) {
                        console.error(`メッセージ ${message.id} の配信内容が不正です:`, err.message)
                        await supabase
                            .from('messages')
                            .update({ status: 'failed', error_message: err.message })
                            .eq('id', message.id)

                        continue
                    }
                    throw err
                }

                // 配信対象ユーザーを取得（1000件上限を避けるため全件ページング取得）
                const { recipients, error: recipientsError } = await resolveRecipients(supabase, {
                    channelId: message.channel_id,
                    filterTags: message.filter_tags,
                    excludeTags: message.exclude_tags,
                })

                // 対象の取得に失敗したまま送ると、一部にしか届かない/除外が効かない事故になるため中断する
                if (recipientsError) {
                    console.error(`メッセージ ${message.id} の配信対象取得エラー:`, recipientsError)
                    await supabase
                        .from('messages')
                        .update({ status: 'failed', error_message: '配信対象の取得に失敗しました' })
                        .eq('id', message.id)

                    continue
                }

                if (recipients.length === 0) {
                    await supabase
                        .from('messages')
                        .update({
                            status: 'sent',
                            total_recipients: 0,
                            success_count: 0,
                            failure_count: 0,
                            error_message: null,
                            sent_at: now,
                        })
                        .eq('id', message.id)

                    processedCount++
                    continue
                }

                // LINE クライアント作成
                const lineClient = new LineClient(channel.channel_access_token)

                // メッセージ送信（500人ずつバッチ処理）
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
                    // {name} を含む場合は個別送信（マルチキャストでは置換できない）
                    const userMap = new Map(recipients.map(r => [r.line_user_id, r.display_name]))
                    const pushBatches = chunk(lineUserIds, 10)

                    for (const batch of pushBatches) {
                        await Promise.all(batch.map(async (userId) => {
                            try {
                                await lineClient.pushMessage(
                                    userId,
                                    replaceNamePlaceholder(lineMessages, userMap.get(userId))
                                )
                                successCount++
                                outcomes.set(userId, { status: 'sent', error: null })
                            } catch (err) {
                                console.error(`個別送信エラー (${userId}):`, err)
                                recordError(err)
                                failureCount++
                                outcomes.set(userId, { status: 'failed', error: toErrorMessage(err) })
                            }
                        }))
                    }
                } else {
                    // マルチキャストは相手ごとの結果を返さないため、バッチ単位の成否を全員に割り当てる
                    for (const batch of batches) {
                        try {
                            await lineClient.multicast(batch, lineMessages)
                            successCount += batch.length
                            batch.forEach(userId => outcomes.set(userId, { status: 'sent', error: null }))
                        } catch (err) {
                            console.error('配信エラー:', err)
                            recordError(err)
                            failureCount += batch.length
                            const detail = toErrorMessage(err)
                            batch.forEach(userId => outcomes.set(userId, { status: 'failed', error: detail }))
                        }
                    }
                }

                // ステータス更新
                // 友だちごとの記録より先に更新する。記録は行数が多く時間がかかるため、
                // 途中で打ち切られても配信履歴が「配信中」のまま止まらないようにする。
                await supabase
                    .from('messages')
                    .update({
                        status: failureCount === recipients.length ? 'failed' : 'sent',
                        total_recipients: recipients.length,
                        success_count: successCount,
                        failure_count: failureCount,
                        error_message: firstError,
                        sent_at: now,
                    })
                    .eq('id', message.id)

                // 友だちごとの配信記録 + 1:1チャットへの反映（既読状況の集計に使う）
                await recordBroadcastDelivery(supabase, {
                    channelId: message.channel_id,
                    messageId: message.id,
                    recipients,
                    outcomes,
                    blocks: lineMessages,
                    sentAt: now,
                })

                processedCount++
            } catch (err) {
                console.error(`メッセージ ${message.id} の処理エラー:`, err)

                await supabase
                    .from('messages')
                    .update({ status: 'failed', error_message: toErrorMessage(err) })
                    .eq('id', message.id)
            }
        }

        return NextResponse.json({
            success: true,
            processed: processedCount,
        })
    } catch (error) {
        console.error('Cronジョブエラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
