/**
 * Googleカレンダーとのやりとり（連携情報の読み出し・トークン更新・予定ありの取得・予定の作成と削除）。
 * googleapis パッケージは使わず、REST API を直接呼ぶ（Vercel の関数を軽く保つため）。
 */

import crypto from 'crypto'
import type { createAdminClient } from '@/lib/supabase/server'
import { allDayToBusy, mergeBusy, type BusyInterval } from './availability'
import { GoogleAuthError, refreshAccessToken } from './oauth'

type AdminClient = ReturnType<typeof createAdminClient>

const GCAL = 'https://www.googleapis.com/calendar/v3'
const TIMEZONE = 'Asia/Tokyo'

export class GoogleCalendarError extends Error {}

export type CalendarConnection = {
    channel_id: string
    google_email: string | null
    calendar_id: string
    refresh_token: string
    access_token: string | null
    access_token_expires_at: string | null
    last_synced_at: string | null
    last_error: string | null
}

export async function getConnection(supabase: AdminClient, channelId: string): Promise<CalendarConnection | null> {
    const { data } = await supabase
        .from('google_calendar_connections')
        .select('channel_id, google_email, calendar_id, refresh_token, access_token, access_token_expires_at, last_synced_at, last_error')
        .eq('channel_id', channelId)
        .maybeSingle()
    return (data as CalendarConnection | null) ?? null
}

export async function recordConnectionError(supabase: AdminClient, channelId: string, message: string | null) {
    await supabase
        .from('google_calendar_connections')
        .update({ last_error: message, updated_at: new Date().toISOString() })
        .eq('channel_id', channelId)
}

/** 有効なアクセストークンを返す（期限が近ければ更新して保存する） */
export async function getAccessToken(supabase: AdminClient, connection: CalendarConnection): Promise<string> {
    const expiresAt = connection.access_token_expires_at ? new Date(connection.access_token_expires_at).getTime() : 0
    if (connection.access_token && expiresAt - Date.now() > 60_000) {
        return connection.access_token
    }
    try {
        const token = await refreshAccessToken(connection.refresh_token)
        const accessExpiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString()
        await supabase
            .from('google_calendar_connections')
            .update({
                access_token: token.access_token,
                access_token_expires_at: accessExpiresAt,
                ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
                updated_at: new Date().toISOString(),
            })
            .eq('channel_id', connection.channel_id)
        connection.access_token = token.access_token
        connection.access_token_expires_at = accessExpiresAt
        return token.access_token
    } catch (err) {
        const message = err instanceof GoogleAuthError
            ? 'Googleカレンダーとの連携が切れています。「面談の日程調整」画面から連携し直してください。'
            : 'Googleカレンダーに接続できませんでした。'
        await recordConnectionError(supabase, connection.channel_id, message)
        throw new GoogleCalendarError(message)
    }
}

async function gcal(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${GCAL}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
        },
    })
}

async function failure(res: Response, label: string): Promise<never> {
    const text = await res.text().catch(() => '')
    throw new GoogleCalendarError(`${label}に失敗しました（HTTP ${res.status}）${text ? `: ${text.slice(0, 300)}` : ''}`)
}

/**
 * 予定がある時間帯を返す。
 * 空き確認（freeBusy）は「予定あり」の予定だけを返すため、「空き時間」扱いの終日予定
 * （出張・休みのメモなど）も別に取り込み、その日は丸1日埋まっているものとして扱う。
 */
export async function fetchBusy(accessToken: string, calendarId: string, timeMin: Date, timeMax: Date): Promise<BusyInterval[]> {
    const res = await gcal(accessToken, '/freeBusy', {
        method: 'POST',
        body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), timeZone: TIMEZONE, items: [{ id: calendarId }] }),
    })
    if (!res.ok) await failure(res, 'カレンダーの予定の確認')
    const data = await res.json() as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }
    const calendar = data.calendars?.[calendarId] ?? Object.values(data.calendars ?? {})[0]
    if (calendar?.errors && calendar.errors.length > 0) {
        throw new GoogleCalendarError(`カレンダーの予定を確認できませんでした: ${JSON.stringify(calendar.errors).slice(0, 200)}`)
    }
    const busy: BusyInterval[] = (calendar?.busy ?? []).map(b => ({ start: new Date(b.start), end: new Date(b.end) }))

    let pageToken: string | undefined
    for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            singleEvents: 'true',
            maxResults: '250',
            fields: 'items(start,end,status),nextPageToken',
        })
        if (pageToken) params.set('pageToken', pageToken)
        const list = await gcal(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`)
        if (!list.ok) await failure(list, 'カレンダーの終日予定の確認')
        const body = await list.json() as { items?: { status?: string; start?: { date?: string }; end?: { date?: string } }[]; nextPageToken?: string }
        for (const item of body.items ?? []) {
            if (item.status === 'cancelled' || !item.start?.date || !item.end?.date) continue
            const interval = allDayToBusy(item.start.date, item.end.date)
            if (interval) busy.push(interval)
        }
        pageToken = body.nextPageToken
        if (!pageToken) break
    }

    return mergeBusy(busy)
}

/**
 * 予約の予定を作る。同じ予約で作り直しても二重にならないよう、予定の ID を予約から決める。
 * Google Meet を付けた場合は URL を返す。
 */
export function eventIdForBooking(slotId: string, bookedAt: string): string {
    // Google の予定 ID に使える文字（0-9, a-v）だけで作る
    return `lm${crypto.createHash('sha256').update(`${slotId}:${bookedAt}`).digest('hex').slice(0, 40)}`
}

type EventResponse = {
    id?: string
    hangoutLink?: string
    conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] }
}

function meetUrlOf(event: EventResponse): string | null {
    return event.hangoutLink
        ?? event.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video' && e.uri?.startsWith('https://meet.google.com/'))?.uri
        ?? null
}

export async function createCalendarEvent(
    accessToken: string,
    calendarId: string,
    input: { id: string; summary: string; description: string; start: Date; end: Date; addMeet: boolean }
): Promise<{ eventId: string; meetingUrl: string | null }> {
    const query = input.addMeet ? '?conferenceDataVersion=1' : ''
    const res = await gcal(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events${query}`, {
        method: 'POST',
        body: JSON.stringify({
            id: input.id,
            summary: input.summary,
            description: input.description,
            start: { dateTime: input.start.toISOString(), timeZone: TIMEZONE },
            end: { dateTime: input.end.toISOString(), timeZone: TIMEZONE },
            ...(input.addMeet
                ? { conferenceData: { createRequest: { requestId: input.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }
                : {}),
        }),
    })

    let event: EventResponse
    if (res.status === 409) {
        // 前回の作成が届いていた（通信の再試行など）。既存の予定を読み直す
        event = await getCalendarEvent(accessToken, calendarId, input.id)
    } else {
        if (!res.ok) await failure(res, 'カレンダーの予定の作成')
        event = await res.json() as EventResponse
    }

    let meetingUrl = meetUrlOf(event)
    if (input.addMeet && !meetingUrl) {
        // Meet の発行が少し遅れることがあるので、1回だけ読み直す
        await new Promise(r => setTimeout(r, 1500))
        meetingUrl = meetUrlOf(await getCalendarEvent(accessToken, calendarId, input.id))
    }
    return { eventId: event.id ?? input.id, meetingUrl }
}

async function getCalendarEvent(accessToken: string, calendarId: string, eventId: string): Promise<EventResponse> {
    const res = await gcal(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1`)
    if (!res.ok) await failure(res, 'カレンダーの予定の取得')
    return await res.json() as EventResponse
}

/** 予定を消す（すでに消えている場合は何もしない） */
export async function deleteCalendarEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
    const res = await gcal(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' })
    if (res.ok || res.status === 404 || res.status === 410) return
    await failure(res, 'カレンダーの予定の削除')
}
