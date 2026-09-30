import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { ReminderError, registerFriendReminder } from '@/lib/reminders/service'

/**
 * 友だちにリマインダーを登録する（管理画面から手動で）
 * POST /api/reminders/register
 * Body: { reminderId, lineUserId（line_users.id）, targetAt（ISO 8601）, label? }
 */
export async function POST(request: NextRequest) {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

    const { reminderId, lineUserId, targetAt, label } = await request.json().catch(() => ({}))
    if (!reminderId || !lineUserId || !targetAt) {
        return NextResponse.json({ error: 'リマインダー・友だち・予定の日時が必要です' }, { status: 400 })
    }

    const supabase = createAdminClient()
    const { data: reminder } = await supabase.from('reminders').select('channel_id').eq('id', reminderId).maybeSingle()
    if (!reminder || !(await isChannelMember(user.id, reminder.channel_id))) {
        return NextResponse.json({ error: 'リマインダーが見つかりません' }, { status: 404 })
    }

    try {
        const result = await registerFriendReminder(supabase, {
            channelId: reminder.channel_id,
            reminderId,
            lineUserId,
            targetAt: new Date(targetAt),
            label: typeof label === 'string' && label.trim() ? label.trim() : null,
            source: 'manual',
        })
        return NextResponse.json({ success: true, ...result })
    } catch (err) {
        if (err instanceof ReminderError) {
            return NextResponse.json({ error: err.message }, { status: 400 })
        }
        console.error('リマインダー登録エラー:', err)
        return NextResponse.json({ error: '登録に失敗しました' }, { status: 500 })
    }
}
