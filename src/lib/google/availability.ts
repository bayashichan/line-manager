/**
 * 受付時間とカレンダーの「予定あり」の時間から、面談の空き枠を求める（日本時間基準）。
 * 入力だけで結果が決まる関数に限定する（DB や Google API には触れない）。
 *
 * 考え方（L Harness と同じ）:
 * - 空き枠は「受付時間」の中だけで作る。カレンダーの空き時間を勝手に広げない
 * - その中で、カレンダーの予定（前後の余白を含む）と重なる時間を除く
 */

import { fromJst } from '@/lib/reminders/timing'
import type { BookingAvailability } from '@/types'

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

export type BusyInterval = { start: Date; end: Date }

function parseHm(value: string): { hour: number; minute: number } | null {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value?.trim() ?? '')
    return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null
}

/** 受付時間の設定が正しいか（画面の保存前チェック用） */
export function validateAvailability(a: BookingAvailability, durationMinutes: number): string | null {
    if (!Array.isArray(a.weekdays) || a.weekdays.length === 0) return '受付する曜日を1つ以上選んでください'
    const start = parseHm(a.start)
    const end = parseHm(a.end)
    if (!start || !end) return '受付時間は "HH:MM" で入力してください'
    const minutes = (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute)
    if (minutes < durationMinutes) return '受付時間が面談の長さより短くなっています'
    return null
}

/**
 * 受付時間から、候補になる開始時刻を並べる。
 * @param minStart これより前に始まる枠は出さない（直近すぎる枠を除く）
 */
export function generateCandidateStarts(input: {
    availability: BookingAvailability
    durationMinutes: number
    intervalMinutes: number
    horizonDays: number
    now: Date
    minStart: Date
}): Date[] {
    const start = parseHm(input.availability.start)
    const end = parseHm(input.availability.end)
    if (!start || !end || input.intervalMinutes <= 0) return []

    const weekdays = new Set(input.availability.weekdays)
    const today = new Date(input.now.getTime() + JST_OFFSET_MS)
    const result: Date[] = []

    for (let d = 0; d <= input.horizonDays; d++) {
        const y = today.getUTCFullYear()
        const m = today.getUTCMonth() + 1
        const day = today.getUTCDate() + d
        const dayStart = fromJst(y, m, day, start.hour, start.minute)
        const dayEnd = fromJst(y, m, day, end.hour, end.minute)
        // 曜日は日本時間の日付で判定する
        const weekday = new Date(dayStart.getTime() + JST_OFFSET_MS).getUTCDay()
        if (!weekdays.has(weekday)) continue

        for (
            let t = dayStart.getTime();
            t + input.durationMinutes * 60000 <= dayEnd.getTime();
            t += input.intervalMinutes * 60000
        ) {
            if (t >= input.minStart.getTime()) result.push(new Date(t))
        }
    }
    return result
}

/** 重なっている・接している予定の時間をまとめる */
export function mergeBusy(intervals: BusyInterval[]): BusyInterval[] {
    const sorted = intervals
        .filter(i => i.end.getTime() > i.start.getTime())
        .sort((a, b) => a.start.getTime() - b.start.getTime())
    const merged: BusyInterval[] = []
    for (const interval of sorted) {
        const last = merged[merged.length - 1]
        if (last && interval.start.getTime() <= last.end.getTime()) {
            if (interval.end.getTime() > last.end.getTime()) last.end = interval.end
        } else {
            merged.push({ start: interval.start, end: interval.end })
        }
    }
    return merged
}

/** 枠（前後の余白を含む）がどの予定とも重ならないか */
export function isFree(start: Date, durationMinutes: number, bufferMinutes: number, busy: BusyInterval[]): boolean {
    const from = start.getTime() - bufferMinutes * 60000
    const to = start.getTime() + (durationMinutes + bufferMinutes) * 60000
    return !busy.some(b => b.start.getTime() < to && b.end.getTime() > from)
}

/**
 * 終日の予定（"2026-10-05" 形式の日付。end は翌日＝含まない）を、日本時間の丸1日の「予定あり」にする。
 * 終日予定は「空き時間」扱いになっていてもカレンダーの空き確認では返らないため、別に取り込む。
 */
export function allDayToBusy(startDate: string, endDateExclusive: string): BusyInterval | null {
    const s = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate)
    const e = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDateExclusive)
    if (!s || !e) return null
    return {
        start: fromJst(Number(s[1]), Number(s[2]), Number(s[3]), 0, 0),
        end: fromJst(Number(e[1]), Number(e[2]), Number(e[3]), 0, 0),
    }
}
