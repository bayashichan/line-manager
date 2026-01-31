import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { chunk } from '@/lib/utils'

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

        // 配信対象ユーザーを取得
        let query = adminClient
            .from('line_users')
            .select('id, line_user_id')
            .eq('channel_id', message.channel_id)
            .eq('is_blocked', false)

        // タグフィルターがある場合
        if (message.filter_tags && message.filter_tags.length > 0) {
            const { data: filteredUsers } = await adminClient
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
            await adminClient
                .from('messages')
                .update({
                    status: 'sent',
                    total_recipients: 0,
                    success_count: 0,
                    failure_count: 0,
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

        // コンテンツの変換（リンク付き画像をFlex Messageに変換）
        const processedContent = (message.content as any[]).map((block: any) => {
            if (block.type === 'image' && block.linkUrl) {
                return {
                    type: 'flex',
                    altText: '画像が送信されました',
                    contents: {
                        type: 'bubble',
                        body: {
                            type: 'box',
                            layout: 'vertical',
                            contents: [
                                {
                                    type: 'image',
                                    url: block.originalContentUrl,
                                    size: 'full',
                                    aspectRatio: block.aspectRatio ? `${block.aspectRatio}:1` : undefined,
                                    aspectMode: 'cover',
                                    action: {
                                        type: 'uri',
                                        uri: block.linkUrl
                                    }
                                }
                            ],
                            paddingAll: '0px'
                        }
                    }
                }
            }
            return block
        })

        for (const batch of batches) {
            try {
                await lineClient.multicast(batch, processedContent)
                successCount += batch.length
            } catch (error) {
                console.error('配信エラー:', error)
                failureCount += batch.length
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
                sent_at: new Date().toISOString(),
            })
            .eq('id', messageId)

        return NextResponse.json({
            success: true,
            total: recipients.length,
            successCount,
            failureCount,
        })
    } catch (error) {
        console.error('メッセージ送信エラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
