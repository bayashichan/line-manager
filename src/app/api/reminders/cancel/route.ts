import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { cancelFriendReminder } from '@/lib/reminders/service'

/**
 * 登録済みのリマインダーを取り消す（まだ送っていないものが止まる）
 * POST /api/reminders/cancel
 * Body: { friendReminderId }
 */
export async function POST(request: NextRequest) {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

    const { friendReminderId } = await request.json().catch(() => ({}))
    if (!friendReminderId) return NextResponse.json({ error: 'friendReminderId が必要です' }, { status: 400 })

    const supabase = createAdminClient()
    const { data: row } = await supabase.from('friend_reminders').select('channel_id').eq('id', friendReminderId).maybeSingle()
    if (!row || !(await isChannelMember(user.id, row.channel_id))) {
        return NextResponse.json({ error: '見つかりません' }, { status: 404 })
    }

    await cancelFriendReminder(supabase, friendReminderId)
    return NextResponse.json({ success: true })
}
