import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { createAdminClient } from '@/lib/supabase/server'
import { recordConnectionError } from '@/lib/google/calendar'
import { syncCalendarSlots } from '@/lib/google/sync'

export const maxDuration = 60

/**
 * Googleカレンダーの空き時間を、いますぐ空き枠に反映する（画面の「今すぐ同期」）
 * POST /api/google/sync  Body: { channelId }
 */
export async function POST(request: NextRequest) {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
    const { channelId } = await request.json().catch(() => ({}))
    if (!(await isChannelMember(user.id, channelId))) return NextResponse.json({ error: '権限がありません' }, { status: 403 })

    const supabase = createAdminClient()
    try {
        return NextResponse.json({ success: true, result: await syncCalendarSlots(supabase, channelId) })
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await recordConnectionError(supabase, channelId, message)
        return NextResponse.json({ error: message }, { status: 502 })
    }
}
