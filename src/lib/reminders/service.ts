/**
 * リマインダー配信の登録・取消・送信。
 *
 * テーブルは supabase/migrations/20261001000000_add_booking_and_reminders.sql。
 * 送信予定（reminder_deliveries）は登録時点の文面を写して持つので、
 * あとでテンプレートを編集しても登録済みの予定は変わらない。
 */

import type { createAdminClient } from '@/lib/supabase/server'
import { LineClient, LineContentError, buildLineMessages, toErrorMessage } from '@/lib/line'
import { logOutgoingMessages } from '@/lib/messaging/chat-log'
import type { MessageContent, ReminderStep } from '@/types'
import { applyReminderPlaceholders, planDeliveries } from './timing'

type AdminClient = ReturnType<typeof createAdminClient>

/** 利用者に見せてよいエラー */
export class ReminderError extends Error {}

export type RegisterReminderInput = {
    channelId: string
    reminderId: string
    /** line_users.id（内部ID） */
    lineUserId: string
    targetAt: Date
    label?: string | null
    source: 'manual' | 'booking' | 'mcp'
    /** {会議URL} に入れる URL（Googleカレンダー連携で発行した Meet など） */
    meetingUrl?: string | null
    now?: Date
}

export async function registerFriendReminder(
    supabase: AdminClient,
    input: RegisterReminderInput
): Promise<{ friendReminderId: string; scheduled: number; sentNow: number; skipped: number }> {
    if (isNaN(input.targetAt.getTime())) throw new ReminderError('予定の日時が正しくありません')

    const { data: reminder } = await supabase
        .from('reminders')
        .select('id, name, is_active, send_missed')
        .eq('id', input.reminderId)
        .eq('channel_id', input.channelId)
        .maybeSingle()
    if (!reminder) throw new ReminderError('リマインダーが見つかりません')
    if (!reminder.is_active) throw new ReminderError('このリマインダーは停止中です')

    const { data: steps } = await supabase
        .from('reminder_steps')
        .select('*')
        .eq('reminder_id', reminder.id)
        .order('step_order')
    if (!steps || steps.length === 0) throw new ReminderError('このリマインダーにはメッセージが登録されていません')

    const { data: friend } = await supabase
        .from('line_users')
        .select('id')
        .eq('id', input.lineUserId)
        .eq('channel_id', input.channelId)
        .maybeSingle()
    if (!friend) throw new ReminderError('友だちが見つかりません')

    const now = input.now ?? new Date()
    const plan = planDeliveries(input.targetAt, steps as ReminderStep[], now, reminder.send_missed)
    const hasPending = plan.some(p => p.status === 'pending')

    const { data: friendReminder, error } = await supabase
        .from('friend_reminders')
        .insert({
            channel_id: input.channelId,
            reminder_id: reminder.id,
            line_user_id: input.lineUserId,
            target_at: input.targetAt.toISOString(),
            label: input.label ?? reminder.name,
            source: input.source,
            // 列が未作成（カレンダー連携のマイグレーション前）でも登録できるよう、URL があるときだけ入れる
            ...(input.meetingUrl ? { meeting_url: input.meetingUrl } : {}),
            status: hasPending ? 'active' : 'completed',
        })
        .select('id')
        .single()
    if (error || !friendReminder) throw new Error(`リマインダーの登録に失敗しました: ${error?.message}`)

    const { error: deliveryError } = await supabase.from('reminder_deliveries').insert(
        plan.map(p => ({
            friend_reminder_id: friendReminder.id,
            step_id: p.step.id,
            step_order: p.step.step_order,
            send_at: p.sendAt.toISOString(),
            content: p.step.content,
            status: p.status,
            error_message: p.status === 'skipped' ? '登録時点で送信時刻を過ぎていたため送りません' : null,
        }))
    )
    if (deliveryError) {
        await supabase.from('friend_reminders').delete().eq('id', friendReminder.id)
        throw new Error(`送信予定の登録に失敗しました: ${deliveryError.message}`)
    }

    return {
        friendReminderId: friendReminder.id,
        scheduled: plan.filter(p => p.status === 'pending' && !p.catchUp).length,
        sentNow: plan.filter(p => p.catchUp).length,
        skipped: plan.filter(p => p.status === 'skipped').length,
    }
}

/** 登録済みのリマインダーを取り消す（まだ送っていないものだけ止まる） */
export async function cancelFriendReminder(supabase: AdminClient, friendReminderId: string): Promise<void> {
    await supabase
        .from('friend_reminders')
        .update({ status: 'cancelled' })
        .eq('id', friendReminderId)
        .eq('status', 'active')
    await supabase
        .from('reminder_deliveries')
        .update({ status: 'cancelled' })
        .eq('friend_reminder_id', friendReminderId)
        .eq('status', 'pending')
}

type DueDelivery = {
    id: string
    friend_reminder_id: string
    content: MessageContent[]
    friend_reminders: {
        id: string
        status: string
        target_at: string
        label: string | null
        meeting_url?: string | null
        channel_id: string
        line_user_id: string
        line_users: { line_user_id: string; display_name: string | null; is_blocked: boolean } | null
        channels: { channel_access_token: string } | null
    } | null
}

/**
 * 送信時刻を過ぎたリマインダーを送る。
 * 1通ごとに「pending → sending」を1回の UPDATE で取り、取れたものだけ送る（二重送信の防止）。
 */
export async function processDueReminderDeliveries(
    supabase: AdminClient,
    now: Date = new Date(),
    limit = 100
): Promise<{ sent: number; failed: number; skipped: number; cancelled: number }> {
    const result = { sent: 0, failed: 0, skipped: 0, cancelled: 0 }

    const dueQuery = (withMeetingUrl: boolean) => supabase
        .from('reminder_deliveries')
        .select(`
            id, friend_reminder_id, content,
            friend_reminders (
                id, status, target_at, label, ${withMeetingUrl ? 'meeting_url, ' : ''}channel_id, line_user_id,
                line_users ( line_user_id, display_name, is_blocked ),
                channels ( channel_access_token )
            )
        `)
        .eq('status', 'pending')
        .lte('send_at', now.toISOString())
        .order('send_at')
        .order('step_order')
        .limit(limit)

    let { data, error } = await dueQuery(true)
    if (error && (error.code === '42703' || error.code === 'PGRST204' || /meeting_url/.test(error.message ?? ''))) {
        // カレンダー連携のマイグレーション前（meeting_url 列がない）でも送信を止めない
        ;({ data, error } = await dueQuery(false))
    }
    if (error) {
        console.error('リマインダーの取得エラー:', error)
        return result
    }

    const touched = new Set<string>()
    for (const delivery of (data ?? []) as unknown as DueDelivery[]) {
        const { data: claimed } = await supabase
            .from('reminder_deliveries')
            .update({ status: 'sending' })
            .eq('id', delivery.id)
            .eq('status', 'pending')
            .select('id')
        if (!claimed || claimed.length === 0) continue

        const fr = delivery.friend_reminders
        touched.add(delivery.friend_reminder_id)

        if (!fr || fr.status !== 'active') {
            await finish(supabase, delivery.id, 'cancelled', null)
            result.cancelled++
            continue
        }
        const user = fr.line_users
        if (!user || user.is_blocked || !fr.channels) {
            await finish(supabase, delivery.id, 'skipped', 'ブロック中のため送りませんでした')
            result.skipped++
            continue
        }

        try {
            const content = applyReminderPlaceholders(delivery.content, {
                name: user.display_name,
                target: new Date(fr.target_at),
                label: fr.label,
                meetingUrl: fr.meeting_url ?? null,
            })
            const messages = buildLineMessages(content)
            await new LineClient(fr.channels.channel_access_token).pushMessage(user.line_user_id, messages)
            await finish(supabase, delivery.id, 'sent', null)
            result.sent++
            await logOutgoingMessages(supabase, {
                channelId: fr.channel_id,
                internalUserId: fr.line_user_id,
                messages,
                updateLastMessage: true,
            })
        } catch (err) {
            const message = err instanceof LineContentError ? `内容がLINEの仕様に合いません: ${err.message}` : toErrorMessage(err)
            console.error(`リマインダー送信エラー (${delivery.id}):`, err)
            await finish(supabase, delivery.id, 'failed', message)
            result.failed++
        }
    }

    // 送る予定が残っていない登録は「完了」にする
    for (const friendReminderId of touched) {
        const { count } = await supabase
            .from('reminder_deliveries')
            .select('id', { count: 'exact', head: true })
            .eq('friend_reminder_id', friendReminderId)
            .in('status', ['pending', 'sending'])
        if ((count ?? 0) === 0) {
            await supabase
                .from('friend_reminders')
                .update({ status: 'completed' })
                .eq('id', friendReminderId)
                .eq('status', 'active')
        }
    }

    return result
}

async function finish(
    supabase: AdminClient,
    deliveryId: string,
    status: 'sent' | 'failed' | 'skipped' | 'cancelled',
    errorMessage: string | null
) {
    await supabase
        .from('reminder_deliveries')
        .update({
            status,
            error_message: errorMessage,
            ...(status === 'sent' ? { sent_at: new Date().toISOString() } : {}),
        })
        .eq('id', deliveryId)
}
