import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { Client } from '@upstash/qstash'

/**
 * 予約配信メッセージの編集
 * POST /api/messages/update
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const { messageId, title, content, filterTags, excludeTags, scheduledAt } = await request.json()

        if (!messageId || !content) {
            return NextResponse.json({ error: 'messageId と content が必要です' }, { status: 400 })
        }

        // メッセージと紐づくチャンネル権限を確認
        const { data: message, error: messageError } = await supabase
            .from('messages')
            .select(`
                id,
                status,
                qstash_message_id,
                channels!inner (
                    id,
                    channel_members!inner (profile_id)
                )
            `)
            .eq('id', messageId)
            .eq('channels.channel_members.profile_id', user.id)
            .single()

        if (messageError || !message) {
            return NextResponse.json({ error: 'メッセージが見つからないか、権限がありません' }, { status: 404 })
        }

        if (message.status !== 'scheduled') {
            return NextResponse.json({ error: 'このメッセージは編集できません（予約中のメッセージのみ編集可能です）' }, { status: 400 })
        }

        const qstashToken = process.env.QSTASH_TOKEN
        if (!qstashToken) {
            return NextResponse.json({ error: 'サーバー設定エラー' }, { status: 500 })
        }

        // 既存のQStashジョブをキャンセル
        if (message.qstash_message_id) {
            try {
                const qstashClient = new Client({ token: qstashToken })
                await qstashClient.messages.delete(message.qstash_message_id)
            } catch (qstashError: any) {
                console.error('QStashメッセージキャンセルエラー:', qstashError)
                // 見つからない場合でも処理を継続
            }
        }

        if (scheduledAt) {
            // 予約日時の検証
            const scheduledTime = new Date(scheduledAt).getTime()
            const now = Date.now()
            if (scheduledTime <= now) {
                return NextResponse.json({ error: '過去の日時は指定できません' }, { status: 400 })
            }

            // DBを更新（予約中のまま）
            const { error: updateError } = await supabase
                .from('messages')
                .update({
                    title: title || '無題の配信',
                    content,
                    filter_tags: filterTags?.length > 0 ? filterTags : null,
                    exclude_tags: excludeTags?.length > 0 ? excludeTags : null,
                    scheduled_at: new Date(scheduledAt).toISOString(),
                    status: 'scheduled',
                    qstash_message_id: null,
                })
                .eq('id', messageId)

            if (updateError) throw updateError

            // 新しいQStashジョブを登録
            const qstashClient = new Client({ token: qstashToken })
            const baseUrl = new URL(request.url).origin
            const destinationUrl = `${baseUrl}/api/webhook/qstash-line`

            const res = await qstashClient.publishJSON({
                url: destinationUrl,
                body: { messageId },
                notBefore: Math.floor(new Date(scheduledAt).getTime() / 1000),
                retries: 3,
                headers: {
                    authorization: `Bearer ${process.env.CRON_SECRET ?? ''}`,
                },
            })

            if (res.messageId) {
                await supabase
                    .from('messages')
                    .update({ qstash_message_id: res.messageId })
                    .eq('id', messageId)
            }

            return NextResponse.json({ success: true, status: 'scheduled' })
        } else {
            // 即時配信に変更：status を 'sending' に更新してフロントエンドから /api/messages/send を呼ばせる
            const { error: updateError } = await supabase
                .from('messages')
                .update({
                    title: title || '無題の配信',
                    content,
                    filter_tags: filterTags?.length > 0 ? filterTags : null,
                    exclude_tags: excludeTags?.length > 0 ? excludeTags : null,
                    scheduled_at: null,
                    status: 'sending',
                    qstash_message_id: null,
                })
                .eq('id', messageId)

            if (updateError) throw updateError

            return NextResponse.json({ success: true, status: 'sending' })
        }
    } catch (error: any) {
        console.error('メッセージ更新エラー:', error)
        return NextResponse.json(
            { error: error?.message || 'メッセージの更新に失敗しました' },
            { status: 500 }
        )
    }
}
