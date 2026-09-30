/**
 * 一斉配信・予約配信の「送信する権利」を1回だけ取るための処理（二重送信の防止）。
 *
 * 予約配信は QStash（/api/webhook/qstash-line）と Cron（/api/cron/scheduled-messages）の
 * 2経路から送られうる。以前は「状態を確認 → 送信中に更新」を別々に行っていたため、
 * 両方が同時に同じ配信を掴むと二重に送られる可能性があった。
 *
 * ここでは「条件に合うときだけ更新する」を1回の UPDATE で行い、更新できた側だけが送る。
 * send_started_at（20260930000000_add_message_send_started_at.sql）が未適用の環境でも
 * 配信が止まらないよう、列がない場合は状態だけを条件にした更新にフォールバックする。
 */

import type { createAdminClient } from '@/lib/supabase/server'

type AdminClient = ReturnType<typeof createAdminClient>

export type ClaimResult = 'claimed' | 'already_taken'

/** PostgreSQL の「列がない」、または PostgREST のスキーマキャッシュに列がないエラーか */
function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
    if (!error) return false
    return error.code === '42703' || error.code === 'PGRST204' || /send_started_at/.test(error.message ?? '')
}

/**
 * 配信を「送信中」にして、送信する権利を取る。
 * @param fromStatuses この状態のときだけ取れる（予約配信は ['scheduled']）
 */
export async function claimMessageForSending(
    supabase: AdminClient,
    messageId: string,
    fromStatuses: string[]
): Promise<ClaimResult> {
    const withMarker = await supabase
        .from('messages')
        .update({ status: 'sending', send_started_at: new Date().toISOString() })
        .eq('id', messageId)
        .in('status', fromStatuses)
        .is('send_started_at', null)
        .select('id')

    if (!withMarker.error) {
        return (withMarker.data ?? []).length > 0 ? 'claimed' : 'already_taken'
    }

    if (!isMissingColumnError(withMarker.error)) {
        throw withMarker.error
    }

    // マイグレーション未適用: 状態だけを条件にする（scheduled → sending は排他になる）
    const statusOnly = await supabase
        .from('messages')
        .update({ status: 'sending' })
        .eq('id', messageId)
        .in('status', fromStatuses)
        .select('id')

    if (statusOnly.error) throw statusOnly.error
    return (statusOnly.data ?? []).length > 0 ? 'claimed' : 'already_taken'
}
