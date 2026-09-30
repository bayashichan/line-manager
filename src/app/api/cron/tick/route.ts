import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { deliverDueStepMessages } from '@/lib/step/deliver-due'
import { processDueReminderDeliveries } from '@/lib/reminders/service'
import { processOfferNudges } from '@/lib/booking/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * 数分おきに呼ぶ定期処理（QStash のスケジュールから5分ごとに呼ぶ想定）
 * GET/POST /api/cron/tick
 *
 * - ステップ配信（/api/cron/step-messages と同じ処理）
 * - リマインダー配信
 * - 面談の日程の催促
 *
 * どれかが失敗しても、ほかの処理は続ける。
 */
async function handler(request: NextRequest) {
    const authHeader = request.headers.get('authorization')
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: '認証エラー' }, { status: 401 })
    }

    const supabase = createAdminClient()
    const summary: Record<string, unknown> = {}

    const tasks: [string, () => Promise<unknown>][] = [
        ['steps', () => deliverDueStepMessages()],
        ['reminders', () => processDueReminderDeliveries(supabase)],
        ['nudges', () => processOfferNudges(supabase)],
    ]
    for (const [name, run] of tasks) {
        try {
            summary[name] = await run()
        } catch (err) {
            console.error(`定期処理エラー (${name}):`, err)
            summary[name] = { error: true }
        }
    }

    return NextResponse.json({ success: true, ...summary })
}

export { handler as GET, handler as POST }
