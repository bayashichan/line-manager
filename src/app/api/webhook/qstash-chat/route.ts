import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { deliverScheduledChatMessage } from '@/lib/messaging/scheduled-chat'

/**
 * QStash から予約時刻に呼ばれ、1:1チャットの送信予約を1件送る
 * POST /api/webhook/qstash-chat
 * Body: { scheduledId }
 *
 * 取り消し済み・送信済みの予約は何もしない。LINE に送れなかったときは失敗として記録し
 * （チャット画面に理由を表示する）、200 を返す。
 */
export async function POST(request: NextRequest) {
    const authHeader = request.headers.get('authorization')
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: '認証エラー' }, { status: 401 })
    }

    const { scheduledId } = await request.json().catch(() => ({}))
    if (!scheduledId) return NextResponse.json({ error: 'scheduledId missing' }, { status: 400 })

    try {
        const result = await deliverScheduledChatMessage(createAdminClient(), scheduledId)
        return NextResponse.json({ success: true, result })
    } catch (err) {
        console.error('チャットの予約送信エラー:', err)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
