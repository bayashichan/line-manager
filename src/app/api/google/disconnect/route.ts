import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { createAdminClient } from '@/lib/supabase/server'
import { getConnection } from '@/lib/google/calendar'
import { revokeToken } from '@/lib/google/oauth'

/**
 * Googleカレンダーとの連携を解除する（空き枠の作り方は「手動」に戻す。作成済みの枠と予定は残す）
 * POST /api/google/disconnect  Body: { channelId }
 */
export async function POST(request: NextRequest) {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
    const { channelId } = await request.json().catch(() => ({}))
    if (!(await isChannelMember(user.id, channelId))) return NextResponse.json({ error: '権限がありません' }, { status: 403 })

    const supabase = createAdminClient()
    const connection = await getConnection(supabase, channelId)
    if (connection) await revokeToken(connection.refresh_token)
    await supabase.from('google_calendar_connections').delete().eq('channel_id', channelId)
    await supabase.from('booking_settings').update({ slot_source: 'manual' }).eq('channel_id', channelId)
    return NextResponse.json({ success: true })
}
