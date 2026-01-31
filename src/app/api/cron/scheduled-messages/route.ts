import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { chunk } from '@/lib/utils'

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

                // 配信対象ユーザーを取得
                let query = supabase
                    .from('line_users')
                    .select('id, line_user_id')
                    .eq('channel_id', message.channel_id)
                    .eq('is_blocked', false)

                // タグフィルターがある場合
                if (message.filter_tags && message.filter_tags.length > 0) {
                    const { data: filteredUsers } = await supabase
                        .from('line_user_tags')
                        .select('line_user_id')
                        .in('tag_id', message.filter_tags)

                    if (filteredUsers) {
                        const userIds = [...new Set(filteredUsers.map(u => u.line_user_id))]
                        query = query.in('id', userIds)
                    }
                }

                const { data: recipients } = await query

                if (!recipients || recipients.length === 0) {
                    await supabase
                        .from('messages')
                        .update({
                            status: 'sent',
                            total_recipients: 0,
                            success_count: 0,
                            failure_count: 0,
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

                for (const batch of batches) {
                    try {
                        await lineClient.multicast(batch, message.content as object[])
                        successCount += batch.length
                    } catch (err) {
                        console.error('配信エラー:', err)
                        failureCount += batch.length
                    }
                }

                // ステータス更新
                await supabase
                    .from('messages')
                    .update({
                        status: failureCount === recipients.length ? 'failed' : 'sent',
                        total_recipients: recipients.length,
                        success_count: successCount,
                        failure_count: failureCount,
                        sent_at: now,
                    })
                    .eq('id', message.id)

                processedCount++
            } catch (err) {
                console.error(`メッセージ ${message.id} の処理エラー:`, err)

                await supabase
                    .from('messages')
                    .update({ status: 'failed' })
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
