/**
 * 1:1チャットの送信予約（予約・取り消し・送信）。
 *
 * テーブルは supabase/migrations/20261004000000_add_scheduled_chat_messages.sql。
 * 予約した時刻になったら、次のどちらかから送る。
 * - QStash: 予約時に「その時刻に /api/webhook/qstash-chat を呼ぶ」ジョブを登録する（時刻ちょうどに届く）
 * - 定期処理（/api/cron/tick、5分ごと）: QStash が使えない・届かなかったときの取りこぼし防止
 * 1件ごとに「pending → sending」を1回の UPDATE で取り、取れた側だけが送る（二重送信の防止）。
 */

import { Client } from '@upstash/qstash'
import type { createAdminClient } from '@/lib/supabase/server'
import { LineClient, LineContentError, MAX_BLOCKS, buildLineMessages, toErrorMessage } from '@/lib/line'
import { logOutgoingMessages } from '@/lib/messaging/chat-log'

type AdminClient = ReturnType<typeof createAdminClient>
type LineMessage = Record<string, unknown>

/** 利用者に見せてよいエラー */
export class ScheduledChatError extends Error {}

/** どこまで先の日時を予約できるか */
export const MAX_SCHEDULE_AHEAD_DAYS = 365

/**
 * QStash から呼ばれたとき、予約時刻の少し前でも送ってよい幅。
 * QStash とこのサーバーの時計がわずかにずれていても、定期処理（最大5分後）まで待たせないため。
 */
const QSTASH_EARLY_TOLERANCE_MS = 60 * 1000

const ALLOWED_TYPES = new Set(['text', 'image', 'video'])

/** 画面から受け取った内容を検証し、保存する形（LINE のメッセージ配列）にする */
export function normalizeScheduledContent(input: unknown): LineMessage[] {
    if (!Array.isArray(input) || input.length === 0) {
        throw new ScheduledChatError('送るメッセージがありません')
    }
    if (input.length > MAX_BLOCKS) {
        throw new ScheduledChatError(`一度に予約できるのは${MAX_BLOCKS}通までです`)
    }
    for (const block of input) {
        const type = block && typeof block === 'object' ? (block as { type?: unknown }).type : undefined
        if (typeof type !== 'string' || !ALLOWED_TYPES.has(type)) {
            throw new ScheduledChatError('予約できるのはテキスト・画像・動画です')
        }
    }
    try {
        return buildLineMessages(input)
    } catch (err) {
        if (err instanceof LineContentError) throw new ScheduledChatError(err.message)
        throw err
    }
}

/** 送信日時を検証する（過去と、1年より先は受け付けない） */
export function parseSendAt(value: unknown, now: Date = new Date()): Date {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ScheduledChatError('送信日時を指定してください')
    }
    const sendAt = new Date(value)
    if (isNaN(sendAt.getTime())) throw new ScheduledChatError('送信日時が正しくありません')
    if (sendAt.getTime() <= now.getTime()) throw new ScheduledChatError('過去の日時は指定できません')
    if (sendAt.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_DAYS * 24 * 60 * 60 * 1000) {
        throw new ScheduledChatError('送信日時は1年以内で指定してください')
    }
    return sendAt
}

export type CreateScheduledChatInput = {
    channelId: string
    /** line_users.id（内部ID） */
    lineUserId: string
    content: unknown
    sendAt: unknown
    /** 予約した担当者（profiles.id） */
    createdBy: string | null
    now?: Date
}

export async function createScheduledChatMessage(
    supabase: AdminClient,
    input: CreateScheduledChatInput
): Promise<{ id: string; sendAt: Date }> {
    const content = normalizeScheduledContent(input.content)
    const sendAt = parseSendAt(input.sendAt, input.now)

    const { data: friend } = await supabase
        .from('line_users')
        .select('id, is_blocked')
        .eq('id', input.lineUserId)
        .eq('channel_id', input.channelId)
        .maybeSingle()
    if (!friend) throw new ScheduledChatError('友だちが見つかりません')
    if (friend.is_blocked) throw new ScheduledChatError('この友だちにはブロックされているため、予約できません')

    const { data, error } = await supabase
        .from('scheduled_chat_messages')
        .insert({
            channel_id: input.channelId,
            line_user_id: input.lineUserId,
            content,
            send_at: sendAt.toISOString(),
            created_by: input.createdBy,
        })
        .select('id')
        .single()
    if (error || !data) throw new Error(`送信予約の登録に失敗しました: ${error?.message}`)

    return { id: data.id, sendAt }
}

/**
 * 予約を取り消す。まだ送っていない予約と、送れなかった予約（一覧から消すため）だけが対象。
 * 送信中・送信済みのものは取り消せない。
 */
export async function cancelScheduledChatMessage(
    supabase: AdminClient,
    id: string
): Promise<'cancelled' | 'not_cancellable'> {
    const { data, error } = await supabase
        .from('scheduled_chat_messages')
        .update({ status: 'cancelled' })
        .eq('id', id)
        .in('status', ['pending', 'failed'])
        .select('id')
    if (error) throw error
    return (data ?? []).length > 0 ? 'cancelled' : 'not_cancellable'
}

/**
 * 予約時刻に送るジョブを QStash に登録する。
 * 登録できなくても予約は有効（定期処理が5分以内に送る）なので、失敗はログに残すだけ。
 */
export async function enqueueScheduledChatDelivery(id: string, sendAt: Date, baseUrl: string): Promise<void> {
    const token = process.env.QSTASH_TOKEN
    if (!token) return
    try {
        await new Client({ token }).publishJSON({
            url: `${baseUrl}/api/webhook/qstash-chat`,
            body: { scheduledId: id },
            notBefore: Math.floor(sendAt.getTime() / 1000),
            retries: 3,
            headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` },
        })
    } catch (err) {
        console.error(`送信予約の QStash 登録エラー (${id}):`, err)
    }
}

type DueRow = {
    id: string
    channel_id: string
    line_user_id: string
    content: unknown
    line_users: { line_user_id: string; is_blocked: boolean | null } | null
    channels: { channel_access_token: string } | null
}

const DUE_COLUMNS = `
    id, channel_id, line_user_id, content,
    line_users ( line_user_id, is_blocked ),
    channels ( channel_access_token )
`

export type DeliveryResult = { sent: number; failed: number }

/** 送信時刻を過ぎた予約をまとめて送る（定期処理から呼ぶ） */
export async function processDueScheduledChatMessages(
    supabase: AdminClient,
    now: Date = new Date(),
    limit = 100
): Promise<DeliveryResult> {
    const result: DeliveryResult = { sent: 0, failed: 0 }

    const { data, error } = await supabase
        .from('scheduled_chat_messages')
        .select(DUE_COLUMNS)
        .eq('status', 'pending')
        .lte('send_at', now.toISOString())
        .order('send_at')
        .limit(limit)
    if (error) {
        console.error('チャットの送信予約の取得エラー:', error)
        return result
    }

    for (const row of (data ?? []) as unknown as DueRow[]) {
        const outcome = await claimAndSend(supabase, row, now)
        if (outcome === 'sent') result.sent++
        if (outcome === 'failed') result.failed++
    }
    return result
}

/** 1件の予約を送る（QStash から予約時刻に呼ばれる） */
export async function deliverScheduledChatMessage(
    supabase: AdminClient,
    id: string,
    now: Date = new Date()
): Promise<'sent' | 'failed' | 'skipped'> {
    const { data, error } = await supabase
        .from('scheduled_chat_messages')
        .select(DUE_COLUMNS)
        .eq('id', id)
        .maybeSingle()
    if (error) throw error
    if (!data) return 'skipped'
    return claimAndSend(supabase, data as unknown as DueRow, new Date(now.getTime() + QSTASH_EARLY_TOLERANCE_MS))
}

/**
 * 送る権利を取ってから送る。予約時刻（dueBy まで）を過ぎた「予約中」のものだけが取れる。
 * 取り消し済み・送信済み・別の経路が送信中のもの、まだ予約時刻になっていないものは送らない。
 */
async function claimAndSend(
    supabase: AdminClient,
    row: DueRow,
    dueBy: Date
): Promise<'sent' | 'failed' | 'skipped'> {
    const { data: claimed } = await supabase
        .from('scheduled_chat_messages')
        .update({ status: 'sending' })
        .eq('id', row.id)
        .eq('status', 'pending')
        .lte('send_at', dueBy.toISOString())
        .select('id')
    if (!claimed || claimed.length === 0) return 'skipped'

    const user = row.line_users
    if (!user || !row.channels) {
        await finish(supabase, row.id, 'failed', '友だちが見つかりません')
        return 'failed'
    }
    if (user.is_blocked) {
        await finish(supabase, row.id, 'failed', 'ブロックされています')
        return 'failed'
    }

    try {
        const messages = buildLineMessages(row.content)
        await new LineClient(row.channels.channel_access_token).pushMessage(user.line_user_id, messages)
        await finish(supabase, row.id, 'sent', null)
        await logOutgoingMessages(supabase, {
            channelId: row.channel_id,
            internalUserId: row.line_user_id,
            messages,
            updateLastMessage: true,
        })
        return 'sent'
    } catch (err) {
        const message = err instanceof LineContentError ? `内容がLINEの仕様に合いません: ${err.message}` : toErrorMessage(err)
        console.error(`チャットの予約送信エラー (${row.id}):`, err)
        await finish(supabase, row.id, 'failed', message)
        return 'failed'
    }
}

/** errorMessage は理由だけ（画面では「…の予約を送れませんでした（理由）」と表示する） */
async function finish(supabase: AdminClient, id: string, status: 'sent' | 'failed', errorMessage: string | null) {
    await supabase
        .from('scheduled_chat_messages')
        .update({
            status,
            error_message: errorMessage,
            ...(status === 'sent' ? { sent_at: new Date().toISOString() } : {}),
        })
        .eq('id', id)
}
