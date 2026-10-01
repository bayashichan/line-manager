import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { cancelScheduledChatMessage } from '@/lib/messaging/scheduled-chat'

/**
 * 1:1チャットの送信予約を取り消す（送れなかった予約を一覧から消すときも使う）
 * POST /api/chat/schedule/cancel
 * Body: { id }
 */
export async function POST(request: NextRequest) {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

    const { id } = await request.json().catch(() => ({}))
    if (!id) return NextResponse.json({ error: 'id が必要です' }, { status: 400 })

    const supabase = createAdminClient()
    const { data: row } = await supabase.from('scheduled_chat_messages').select('channel_id').eq('id', id).maybeSingle()
    if (!row || !(await isChannelMember(user.id, row.channel_id))) {
        return NextResponse.json({ error: '見つかりません' }, { status: 404 })
    }

    try {
        const result = await cancelScheduledChatMessage(supabase, id)
        if (result === 'not_cancellable') {
            return NextResponse.json({ error: 'すでに送信済みか送信中のため、取り消せません' }, { status: 409 })
        }
        return NextResponse.json({ success: true })
    } catch (err) {
        console.error('チャットの送信予約の取り消しエラー:', err)
        return NextResponse.json({ error: '取り消しに失敗しました' }, { status: 500 })
    }
}
