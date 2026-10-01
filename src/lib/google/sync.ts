/**
 * Googleカレンダーの空き時間を、面談の空き枠（booking_slots）に反映する。
 * 定期処理（/api/cron/tick）と、画面の「今すぐ同期」から呼ぶ。
 *
 * - 受付時間の中で、予定と重ならない時間に「空き」の枠を作る（source = calendar）
 * - 予定が入った時間の空き枠は「締切」にする（closed_by = calendar）。手動の枠も対象
 * - 予定がなくなれば、カレンダーが締め切った枠だけ「空き」に戻す（手動で締め切った枠はそのまま）
 * - 枠は削除しない（案内済みの候補の番号がずれないようにするため）
 */

import type { createAdminClient } from '@/lib/supabase/server'
import type { BookingSettings } from '@/types'
import { generateCandidateStarts, isFree } from './availability'
import { fetchBusy, getAccessToken, getConnection, recordConnectionError, GoogleCalendarError } from './calendar'

type AdminClient = ReturnType<typeof createAdminClient>

export type SyncResult = { created: number; closed: number; reopened: number } | { skipped: string }

export async function syncCalendarSlots(supabase: AdminClient, channelId: string, now: Date = new Date()): Promise<SyncResult> {
    const { data: settings } = await supabase.from('booking_settings').select('*').eq('channel_id', channelId).maybeSingle()
    if (!settings || (settings as BookingSettings).slot_source !== 'calendar') return { skipped: 'カレンダーから空き枠を作る設定になっていません' }
    const s = settings as BookingSettings

    const connection = await getConnection(supabase, channelId)
    if (!connection) return { skipped: 'Googleカレンダーと連携していません' }

    const token = await getAccessToken(supabase, connection)
    const horizonEnd = new Date(now.getTime() + (s.horizon_days + 1) * 24 * 3600 * 1000)
    const busy = await fetchBusy(token, connection.calendar_id, new Date(now.getTime() - s.buffer_minutes * 60000), horizonEnd)

    const candidates = generateCandidateStarts({
        availability: s.availability,
        durationMinutes: s.slot_duration_minutes,
        intervalMinutes: s.slot_interval_minutes,
        horizonDays: s.horizon_days,
        now,
        minStart: now,
    })
    const candidateSet = new Set(candidates.map(c => c.toISOString()))
    const free = candidates.filter(c => isFree(c, s.slot_duration_minutes, s.buffer_minutes, busy))
    const freeSet = new Set(free.map(c => c.toISOString()))

    const { data: existing } = await supabase
        .from('booking_slots')
        .select('id, start_at, status, source, closed_by, duration_minutes')
        .eq('channel_id', channelId)
        .gte('start_at', now.toISOString())
    const byTime = new Map((existing ?? []).map(row => [new Date(row.start_at).toISOString(), row]))

    const result = { created: 0, closed: 0, reopened: 0 }

    const toInsert = free
        .filter(c => !byTime.has(c.toISOString()))
        .map(c => ({
            channel_id: channelId,
            start_at: c.toISOString(),
            source: 'calendar',
            duration_minutes: s.slot_duration_minutes,
        }))
    if (toInsert.length > 0) {
        const { data: inserted, error } = await supabase
            .from('booking_slots')
            .upsert(toInsert, { onConflict: 'channel_id,start_at', ignoreDuplicates: true })
            .select('id')
        if (error) throw new GoogleCalendarError(`空き枠の作成に失敗しました: ${error.message}`)
        result.created = inserted?.length ?? 0
    }

    for (const row of existing ?? []) {
        const iso = new Date(row.start_at).toISOString()
        const duration = row.duration_minutes ?? s.slot_duration_minutes
        const busyNow = !isFree(new Date(row.start_at), duration, s.buffer_minutes, busy)
        const outsideHours = row.source === 'calendar' && !candidateSet.has(iso)

        if (row.status === 'open' && (busyNow || outsideHours)) {
            const { data } = await supabase
                .from('booking_slots')
                .update({ status: 'closed', closed_by: 'calendar' })
                .eq('id', row.id)
                .eq('status', 'open')
                .select('id')
            result.closed += data?.length ?? 0
        } else if (row.status === 'closed' && row.closed_by === 'calendar' && !busyNow && !outsideHours
            && (row.source === 'manual' || freeSet.has(iso))) {
            const { data } = await supabase
                .from('booking_slots')
                .update({ status: 'open', closed_by: null })
                .eq('id', row.id)
                .eq('status', 'closed')
                .eq('closed_by', 'calendar')
                .select('id')
            result.reopened += data?.length ?? 0
        }
    }

    await supabase
        .from('google_calendar_connections')
        .update({ last_synced_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() })
        .eq('channel_id', channelId)

    return result
}

/** カレンダーから空き枠を作る設定のチャンネルをすべて同期する（定期処理用） */
export async function syncAllCalendarSlots(supabase: AdminClient, now: Date = new Date()) {
    const { data } = await supabase.from('booking_settings').select('channel_id').eq('slot_source', 'calendar')
    const results: Record<string, SyncResult | { error: string }> = {}
    for (const row of data ?? []) {
        try {
            results[row.channel_id] = await syncCalendarSlots(supabase, row.channel_id, now)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.error(`カレンダー同期エラー (${row.channel_id}):`, err)
            await recordConnectionError(supabase, row.channel_id, message)
            results[row.channel_id] = { error: message }
        }
    }
    return results
}
