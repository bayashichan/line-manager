/**
 * リマインダー配信の送信時刻の計算と、日時の表記（すべて日本時間基準）。
 *
 * 入力だけで結果が決まる関数に限定し、DB やLINEには触れない（テストしやすくするため）。
 */

import type { MessageContent, ReminderTimingType } from '@/types'

const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

export type ReminderTiming = {
    timing_type: ReminderTimingType
    offset_days: number
    send_hour: number | null
    send_minute: number
    offset_minutes: number
}

/** 日本時間の年月日・時分に分解する */
function toJstParts(date: Date) {
    const jst = new Date(date.getTime() + JST_OFFSET_MS)
    return {
        year: jst.getUTCFullYear(),
        month: jst.getUTCMonth() + 1,
        day: jst.getUTCDate(),
        weekday: WEEKDAYS[jst.getUTCDay()],
        hour: jst.getUTCHours(),
        minute: jst.getUTCMinutes(),
    }
}

/** 日本時間の「年・月・日・時・分」から実際の時刻を作る */
export function fromJst(year: number, month: number, day: number, hour: number, minute: number): Date {
    return new Date(Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MS)
}

/**
 * 予定の日時（target）と、ステップのタイミングから送信時刻を求める。
 * - day_time: 予定日（日本時間の日付）の offset_days 日後の HH:MM
 * - relative: 予定時刻の offset_minutes 分後（マイナスなら前）
 */
export function computeSendAt(target: Date, timing: ReminderTiming): Date {
    if (timing.timing_type === 'relative') {
        return new Date(target.getTime() + timing.offset_minutes * 60000)
    }
    const t = toJstParts(target)
    const hour = timing.send_hour ?? t.hour
    const minute = timing.send_hour === null ? t.minute : timing.send_minute
    return fromJst(t.year, t.month, t.day + timing.offset_days, hour, minute)
}

export type PlannedDelivery<T> = {
    step: T
    sendAt: Date
    /** pending: 送信予定 / skipped: 送信時刻を過ぎているため送らない */
    status: 'pending' | 'skipped'
    /** 送信時刻を過ぎていたため、登録直後に送る */
    catchUp: boolean
}

/**
 * 登録時に、各ステップの送信予定を決める。
 *
 * 送信時刻をすでに過ぎているステップ:
 * - 予定の前に送るもの（事前質問など）で sendMissed なら、すぐ送る（予定を過ぎていたら送らない）
 * - それ以外は送らない（skipped）
 */
export function planDeliveries<T extends ReminderTiming & { step_order: number }>(
    target: Date,
    steps: T[],
    now: Date,
    sendMissed: boolean
): PlannedDelivery<T>[] {
    return [...steps]
        .sort((a, b) => a.step_order - b.step_order)
        .map(step => {
            const sendAt = computeSendAt(target, step)
            if (sendAt.getTime() >= now.getTime()) {
                return { step, sendAt, status: 'pending' as const, catchUp: false }
            }
            const beforeTarget = sendAt.getTime() <= target.getTime()
            if (sendMissed && beforeTarget && target.getTime() > now.getTime()) {
                return { step, sendAt: now, status: 'pending' as const, catchUp: true }
            }
            return { step, sendAt, status: 'skipped' as const, catchUp: false }
        })
}

/** 例: "10月3日(金) 10:00" */
export function formatJstDateTime(date: Date): string {
    return `${formatJstDate(date)} ${formatJstTime(date)}`
}

/** 例: "10月3日(金)" */
export function formatJstDate(date: Date): string {
    const t = toJstParts(date)
    return `${t.month}月${t.day}日(${t.weekday})`
}

/** 例: "10:00" */
export function formatJstTime(date: Date): string {
    const t = toJstParts(date)
    return `${t.hour}:${String(t.minute).padStart(2, '0')}`
}

/** 例: "10/3(金) 10:00"（ボタンなど短く表示したいとき） */
export function formatJstShort(date: Date): string {
    const t = toJstParts(date)
    return `${t.month}/${t.day}(${t.weekday}) ${t.hour}:${String(t.minute).padStart(2, '0')}`
}

/** 人が読むタイミング表記（例: "3日前 20:00" / "当日 9:00" / "1時間前" / "30分後"） */
export function describeReminderTiming(timing: ReminderTiming): string {
    if (timing.timing_type === 'relative') {
        const m = timing.offset_minutes
        if (m === 0) return '予定の時刻ちょうど'
        const abs = Math.abs(m)
        const amount = abs % 60 === 0 ? `${abs / 60}時間` : abs >= 60 ? `${Math.floor(abs / 60)}時間${abs % 60}分` : `${abs}分`
        return `${amount}${m < 0 ? '前' : '後'}`
    }
    const d = timing.offset_days
    const day = d === 0 ? '当日' : d === -1 ? '前日' : d === 1 ? '翌日' : d < 0 ? `${-d}日前` : `${d}日後`
    if (timing.send_hour === null) return `${day}（予定と同じ時刻）`
    return `${day} ${timing.send_hour}:${String(timing.send_minute).padStart(2, '0')}`
}

/**
 * 文面の差し込み。テキストだけを置き換える。
 * {name} 友だちの表示名 / {日時} 10月3日(土) 10:00 / {日付} 10月3日(土) / {時刻} 10:00 / {予定} ラベル
 * {会議URL} Googleカレンダー連携で発行した Meet の URL（ないときは空）
 */
export function applyReminderPlaceholders(
    content: MessageContent[],
    values: PlaceholderValues
): MessageContent[] {
    return content.map(block => {
        if (block.type !== 'text' || typeof block.text !== 'string') return block
        return { ...block, text: fillPlaceholders(block.text, values) }
    })
}

export type PlaceholderValues = {
    name?: string | null
    target?: Date | null
    label?: string | null
    /** Googleカレンダー連携で発行した Meet などの URL */
    meetingUrl?: string | null
}

export function fillPlaceholders(text: string, values: PlaceholderValues): string {
    let result = text.replace(/{name}/g, values.name || '友だち')
    if (values.target) {
        result = result
            .replace(/{日時}/g, formatJstDateTime(values.target))
            .replace(/{日付}/g, formatJstDate(values.target))
            .replace(/{時刻}/g, formatJstTime(values.target))
    }
    if (values.label !== undefined) {
        result = result.replace(/{予定}/g, values.label || '')
    }
    if (values.meetingUrl !== undefined) {
        result = result.replace(/{会議URL}/g, values.meetingUrl || '')
    }
    return result
}
