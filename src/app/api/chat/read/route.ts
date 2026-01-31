import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * 既読処理API
 * POST /api/chat/read
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const { channelId, lineUserId } = body

        if (!channelId || !lineUserId) {
            return NextResponse.json(
                { error: 'パラメータが不足しています' },
                { status: 400 }
            )
        }

        const supabase = await createClient()

        // 1. 未読メッセージを既読にする
        const { error: msgError } = await supabase
            .from('chat_messages')
            .update({ read_at: new Date().toISOString() })
            .eq('channel_id', channelId)
            .eq('line_user_id', lineUserId)
            .eq('sender', 'user') // 相手からのメッセージのみ
            .is('read_at', null)

        if (msgError) {
            console.error('既読処理エラー(messages):', msgError)
            return NextResponse.json({ error: '既読更新に失敗しました' }, { status: 500 })
        }

        // 2. ユーザーの未読カウントをリセット
        const { error: userError } = await supabase
            .from('line_users')
            .update({ unread_count: 0 })
            .eq('id', lineUserId)

        if (userError) {
            console.error('既読処理エラー(user):', userError)
            return NextResponse.json({ error: '未読数リセットに失敗しました' }, { status: 500 })
        }

        return NextResponse.json({ success: true })

    } catch (error) {
        console.error('既読APIエラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
