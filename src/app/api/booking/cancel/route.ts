import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { cancelBooking } from '@/lib/booking/service'

/**
 * 面談の予約を取り消して、枠を空きに戻す（登録済みのリマインダーも止める）。
 * 相手への連絡は自動では送らない（取り消しの理由はそれぞれ違うため）。
 * POST /api/booking/cancel
 * Body: { slotId }
 */
export async function POST(request: NextRequest) {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

    const { slotId } = await request.json().catch(() => ({}))
    if (!slotId) return NextResponse.json({ error: 'slotId が必要です' }, { status: 400 })

    const supabase = createAdminClient()
    const { data: slot } = await supabase.from('booking_slots').select('channel_id, status').eq('id', slotId).maybeSingle()
    if (!slot || !(await isChannelMember(user.id, slot.channel_id))) {
        return NextResponse.json({ error: '枠が見つかりません' }, { status: 404 })
    }
    if (slot.status !== 'booked') {
        return NextResponse.json({ error: '予約されていない枠です' }, { status: 400 })
    }

    await cancelBooking(supabase, slotId)
    return NextResponse.json({ success: true })
}
