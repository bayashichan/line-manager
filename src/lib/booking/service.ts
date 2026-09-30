/**
 * 面談の日程調整（候補の自動返信・番号での回答・確定・催促・取消）。
 *
 * 流れ:
 * 1. 友だちが「個別」などのキーワードを送る → 空き枠から候補を番号付きで返信（ボタン付き）
 * 2. 番号（またはボタン）で返事 → 枠を確保して確定の返信、タグ付け、リマインダー登録
 *    「別の日程を希望」「今回は見送る」にもそれぞれ返信する
 * 3. 返事がないまま一定時間たったら、1回だけ催促する（何か返事があれば催促しない）
 *
 * 返信は応答（Reply）API を使うので送信枠を消費しない。催促はプッシュ（1通消費）。
 * 同じ枠を2人が同時に選んでも、枠の確保は1回の UPDATE で行うので先着1人だけが確定する。
 */

import type { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { logOutgoingMessages } from '@/lib/messaging/chat-log'
import { cancelFriendReminder, registerFriendReminder } from '@/lib/reminders/service'
import type { BookingSettings } from '@/types'
import {
    buildOfferMessage,
    buildOfferOptions,
    fillBookingText,
    matchesTriggerKeyword,
    parseOfferAnswer,
    type OfferOption,
} from './offer'

type AdminClient = ReturnType<typeof createAdminClient>
type Friend = { id: string; display_name: string | null }

type SlotRow = { id: string; start_at: string; status: string }

/** 案内した順に枠を並べる（DB からは順不同で返るため） */
async function loadOfferSlots(supabase: AdminClient, slotIds: string[]): Promise<SlotRow[]> {
    if (slotIds.length === 0) return []
    const { data } = await supabase.from('booking_slots').select('id, start_at, status').in('id', slotIds)
    const byId = new Map((data ?? []).map(s => [s.id, s as SlotRow]))
    return slotIds.map(id => byId.get(id)).filter((s): s is SlotRow => Boolean(s))
}

function labels(settings: BookingSettings) {
    return { other: settings.other_label, decline: settings.decline_label }
}

async function reply(
    supabase: AdminClient,
    lineClient: LineClient,
    replyToken: string,
    channelId: string,
    friend: Friend,
    messages: Record<string, unknown>[]
) {
    await lineClient.replyMessage(replyToken, messages)
    await logOutgoingMessages(supabase, { channelId, internalUserId: friend.id, messages })
}

/**
 * Webhook で受け取ったテキストメッセージを日程調整として処理する。
 * 返信した（応答トークンを使った）ときは true を返す。呼び出し元はそのあと自動応答を行わない。
 */
export async function handleBookingMessage(
    supabase: AdminClient,
    lineClient: LineClient,
    input: { channelId: string; lineUserId: string; text: string; replyToken?: string }
): Promise<boolean> {
    if (!input.replyToken || !input.text) return false

    const { data: settings } = await supabase
        .from('booking_settings')
        .select('*')
        .eq('channel_id', input.channelId)
        .maybeSingle()
    if (!settings || !settings.is_active) return false

    const { data: friend } = await supabase
        .from('line_users')
        .select('id, display_name')
        .eq('channel_id', input.channelId)
        .eq('line_user_id', input.lineUserId)
        .maybeSingle()
    if (!friend) return false

    const isTrigger = matchesTriggerKeyword(input.text, settings.trigger_keywords ?? [])

    const { data: pending } = await supabase
        .from('booking_offers')
        .select('id, slot_ids, responded_at')
        .eq('line_user_id', friend.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (pending && !isTrigger) {
        const options = buildOfferOptions(await loadOfferSlots(supabase, pending.slot_ids ?? []), labels(settings))
        const answer = parseOfferAnswer(input.text, options)
        if (answer) {
            await applyAnswer(supabase, lineClient, settings, friend, pending.id, answer, input.replyToken)
            return true
        }
        // 番号以外の返事（質問など）が来たら、担当者が対応するので催促はしない
        if (!pending.responded_at) {
            await supabase.from('booking_offers').update({ responded_at: new Date().toISOString() }).eq('id', pending.id)
        }
        return false
    }

    if (isTrigger) {
        await sendNewOffer(supabase, lineClient, settings, friend, input.replyToken, null)
        return true
    }

    return false
}

/** 候補を送る。前の候補（回答待ち）は「差し替え」にする */
async function sendNewOffer(
    supabase: AdminClient,
    lineClient: LineClient,
    settings: BookingSettings,
    friend: Friend,
    replyToken: string,
    prefixText: string | null
) {
    await supabase
        .from('booking_offers')
        .update({ status: 'superseded' })
        .eq('line_user_id', friend.id)
        .eq('status', 'pending')

    const earliest = new Date(Date.now() + settings.min_lead_hours * 3600 * 1000).toISOString()
    const { data: slots } = await supabase
        .from('booking_slots')
        .select('id, start_at, status')
        .eq('channel_id', settings.channel_id)
        .eq('status', 'open')
        .gte('start_at', earliest)
        .order('start_at')
        .limit(settings.offer_count)

    const prefix = prefixText ? [{ type: 'text', text: prefixText }] : []

    if (!slots || slots.length === 0) {
        await supabase.from('booking_offers').insert({
            channel_id: settings.channel_id,
            line_user_id: friend.id,
            status: 'no_slots',
            answered_at: new Date().toISOString(),
        })
        await reply(supabase, lineClient, replyToken, settings.channel_id, friend, [
            ...prefix,
            { type: 'text', text: fillBookingText(settings.no_slots_text, { name: friend.display_name }) },
        ])
        return
    }

    await supabase.from('booking_offers').insert({
        channel_id: settings.channel_id,
        line_user_id: friend.id,
        status: 'pending',
        slot_ids: slots.map(s => s.id),
    })

    const options = buildOfferOptions(slots, labels(settings))
    const header = fillBookingText(settings.intro_text, { name: friend.display_name })
    await reply(supabase, lineClient, replyToken, settings.channel_id, friend, [
        ...prefix,
        buildOfferMessage(header, options),
    ])
}

async function applyAnswer(
    supabase: AdminClient,
    lineClient: LineClient,
    settings: BookingSettings,
    friend: Friend,
    offerId: string,
    option: OfferOption,
    replyToken: string
) {
    const now = new Date().toISOString()

    if (option.kind === 'other' || option.kind === 'decline') {
        await supabase
            .from('booking_offers')
            .update({ status: option.kind === 'other' ? 'other' : 'declined', answered_at: now, responded_at: now })
            .eq('id', offerId)
            .eq('status', 'pending')
        const text = option.kind === 'other' ? settings.other_text : settings.decline_text
        await reply(supabase, lineClient, replyToken, settings.channel_id, friend, [
            { type: 'text', text: fillBookingText(text, { name: friend.display_name }) },
        ])
        return
    }

    // 枠を確保（空いているときだけ。同時に選ばれても先着1人）
    const { data: booked } = await supabase
        .from('booking_slots')
        .update({ status: 'booked', line_user_id: friend.id, booked_at: now })
        .eq('id', option.slotId)
        .eq('status', 'open')
        .select('id, start_at')
    if (!booked || booked.length === 0) {
        // 埋まっていた: お詫びして、残りの枠で候補を出し直す
        await sendNewOffer(supabase, lineClient, settings, friend, replyToken,
            fillBookingText(settings.taken_text, { name: friend.display_name }))
        return
    }

    const startAt = new Date(booked[0].start_at)
    await supabase
        .from('booking_offers')
        .update({ status: 'booked', booked_slot_id: option.slotId, answered_at: now, responded_at: now })
        .eq('id', offerId)

    // 応答トークンの期限があるので、確定の返信を先に行う。
    // 返信に失敗しても予約は確定済みなので、タグ付けとリマインダー登録は必ず行う。
    try {
        await reply(supabase, lineClient, replyToken, settings.channel_id, friend, [
            { type: 'text', text: fillBookingText(settings.booked_text, { name: friend.display_name, target: startAt }) },
        ])
    } catch (err) {
        console.error(`日程確定の返信エラー (friend: ${friend.id}):`, err)
    }

    await afterBooked(supabase, settings, friend, offerId, startAt)
}

/** 確定後: タグ付けとリマインダー登録（失敗しても予約自体は確定済み） */
async function afterBooked(
    supabase: AdminClient,
    settings: BookingSettings,
    friend: Friend,
    offerId: string,
    startAt: Date
) {
    if (settings.booked_tag_id) {
        try {
            await supabase
                .from('line_user_tags')
                .upsert({ line_user_id: friend.id, tag_id: settings.booked_tag_id }, { onConflict: 'line_user_id,tag_id' })
            // タグ連動リッチメニューの切り替えと、タグ付与で始まるステップ配信
            const { processRichMenuSwitchOnTagAssign } = await import('@/lib/rich-menu')
            await processRichMenuSwitchOnTagAssign(friend.id, settings.booked_tag_id)
        } catch (err) {
            console.error(`日程確定時のタグ付けエラー (friend: ${friend.id}):`, err)
        }
    }

    if (settings.reminder_id) {
        try {
            // 以前の予約で登録したリマインダーが残っていれば止める（日程変更に備える）
            const { data: previous } = await supabase
                .from('friend_reminders')
                .select('id')
                .eq('line_user_id', friend.id)
                .eq('reminder_id', settings.reminder_id)
                .eq('source', 'booking')
                .eq('status', 'active')
            for (const row of previous ?? []) {
                await cancelFriendReminder(supabase, row.id)
            }

            const { friendReminderId } = await registerFriendReminder(supabase, {
                channelId: settings.channel_id,
                reminderId: settings.reminder_id,
                lineUserId: friend.id,
                targetAt: startAt,
                label: settings.session_label,
                source: 'booking',
            })
            await supabase.from('booking_offers').update({ friend_reminder_id: friendReminderId }).eq('id', offerId)
        } catch (err) {
            console.error(`日程確定時のリマインダー登録エラー (friend: ${friend.id}):`, err)
        }
    }
}

type NudgeOffer = {
    id: string
    channel_id: string
    slot_ids: string[]
    created_at: string
    line_users: { id: string; line_user_id: string; display_name: string | null; is_blocked: boolean } | null
    channels: { channel_access_token: string } | null
}

/**
 * 返事がない候補に1回だけ催促する（Cron から呼ぶ）。
 * 催促済みの印（nudged_at）を先に1回の UPDATE で付け、付けられたものだけ送る。
 */
export async function processOfferNudges(
    supabase: AdminClient,
    now: Date = new Date(),
    limit = 50
): Promise<{ nudged: number; skipped: number }> {
    const result = { nudged: 0, skipped: 0 }

    const { data: settingsRows } = await supabase
        .from('booking_settings')
        .select('*')
        .eq('is_active', true)
        .eq('nudge_enabled', true)
    if (!settingsRows || settingsRows.length === 0) return result

    for (const settings of settingsRows as BookingSettings[]) {
        const dueBefore = new Date(now.getTime() - settings.nudge_after_hours * 3600 * 1000).toISOString()
        const { data: offers } = await supabase
            .from('booking_offers')
            .select('id, channel_id, slot_ids, created_at, line_users ( id, line_user_id, display_name, is_blocked ), channels ( channel_access_token )')
            .eq('channel_id', settings.channel_id)
            .eq('status', 'pending')
            .is('nudged_at', null)
            .is('responded_at', null)
            .lte('created_at', dueBefore)
            .order('created_at')
            .limit(limit)

        for (const offer of (offers ?? []) as unknown as NudgeOffer[]) {
            const { data: claimed } = await supabase
                .from('booking_offers')
                .update({ nudged_at: now.toISOString() })
                .eq('id', offer.id)
                .eq('status', 'pending')
                .is('nudged_at', null)
                .is('responded_at', null)
                .select('id')
            if (!claimed || claimed.length === 0) continue

            const friend = offer.line_users
            const slots = await loadOfferSlots(supabase, offer.slot_ids ?? [])
            const options = buildOfferOptions(slots, labels(settings))
            const stillOpen = options.some(o => o.kind === 'slot' && o.available)
            if (!friend || friend.is_blocked || !offer.channels || !stillOpen) {
                result.skipped++
                continue
            }

            try {
                const message = buildOfferMessage(fillBookingText(settings.nudge_text, { name: friend.display_name }), options)
                await new LineClient(offer.channels.channel_access_token).pushMessage(friend.line_user_id, [message])
                await logOutgoingMessages(supabase, {
                    channelId: offer.channel_id,
                    internalUserId: friend.id,
                    messages: [message],
                    updateLastMessage: true,
                })
                result.nudged++
            } catch (err) {
                console.error(`日程の催促エラー (offer: ${offer.id}):`, err)
                result.skipped++
            }
        }
    }

    return result
}

/** 予約を取り消して枠を空きに戻す（管理画面から）。リマインダーも止める */
export async function cancelBooking(supabase: AdminClient, slotId: string): Promise<void> {
    const { data: offers } = await supabase
        .from('booking_offers')
        .select('id, friend_reminder_id')
        .eq('booked_slot_id', slotId)
        .eq('status', 'booked')
    for (const offer of offers ?? []) {
        if (offer.friend_reminder_id) await cancelFriendReminder(supabase, offer.friend_reminder_id)
        await supabase.from('booking_offers').update({ status: 'cancelled' }).eq('id', offer.id)
    }
    await supabase
        .from('booking_slots')
        .update({ status: 'open', line_user_id: null, booked_at: null })
        .eq('id', slotId)
}
