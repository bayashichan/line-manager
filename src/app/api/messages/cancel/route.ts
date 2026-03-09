import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { Client } from '@upstash/qstash'

/**
 * 予約配信のキャンセル
 * POST /api/messages/cancel
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
            return NextResponse.json({ error: 'このメッセージは既にキャンセルまたは送信されています' }, { status: 400 })
        }

        // QStash クライアント初期化
        const qstashToken = process.env.QSTASH_TOKEN
        if (!qstashToken) {
            return NextResponse.json({ error: 'サーバー設定エラー' }, { status: 500 })
        }

        // QStash上のジョブをキャンセル (IDがある場合のみ)
        if (message.qstash_message_id) {
            try {
                const qstashClient = new Client({ token: qstashToken })
                await qstashClient.messages.delete(message.qstash_message_id)
            } catch (qstashError: any) {
                console.error('QStashメッセージキャンセルエラー:', qstashError)
                // QStash側で既に見つからない場合でも、DB側のステータスは更新する
            }
        }

        // データベースのステータスを cancelled に更新
        const { error: updateError } = await supabase
            .from('messages')
            .update({ status: 'cancelled' })
            .eq('id', messageId)

        if (updateError) {
            throw updateError
        }

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('キャンセルエラー:', error)
        return NextResponse.json(
            { error: error?.message || 'キャンセル処理に失敗しました' },
            { status: 500 }
        )
    }
}
