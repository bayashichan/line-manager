import { describe, expect, it } from 'vitest'
import { fromJst, formatJstShort } from '@/lib/reminders/timing'
import { allDayToBusy, generateCandidateStarts, isFree, mergeBusy, validateAvailability } from './availability'

// 2026-10-05(月) 09:00 JST
const now = fromJst(2026, 10, 5, 9, 0)
const weekdays = { weekdays: [1, 2, 3, 4, 5], start: '10:00', end: '13:00' }

describe('generateCandidateStarts（受付時間から候補を作る・日本時間）', () => {
    it('受付する曜日・時間帯の中だけで、間隔ごとに候補を作る', () => {
        const starts = generateCandidateStarts({ availability: weekdays, durationMinutes: 60, intervalMinutes: 60, horizonDays: 6, now, minStart: now })
        const labels = starts.map(formatJstShort)
        expect(labels.slice(0, 3)).toEqual(['10/5(月) 10:00', '10/5(月) 11:00', '10/5(月) 12:00'])
        // 土日（10/10, 10/11）は受付しない
        expect(labels.some(l => l.includes('(土)') || l.includes('(日)'))).toBe(false)
        // 終了時刻を超える枠（12:00 開始の 90 分など）は作らない
        expect(generateCandidateStarts({ availability: weekdays, durationMinutes: 90, intervalMinutes: 60, horizonDays: 0, now, minStart: now })
            .map(formatJstShort)).toEqual(['10/5(月) 10:00', '10/5(月) 11:00'])
    })

    it('直近すぎる枠は出さない', () => {
        const minStart = fromJst(2026, 10, 5, 11, 30)
        const starts = generateCandidateStarts({ availability: weekdays, durationMinutes: 60, intervalMinutes: 60, horizonDays: 0, now, minStart })
        expect(starts.map(formatJstShort)).toEqual(['10/5(月) 12:00'])
    })

    it('30分刻み', () => {
        const starts = generateCandidateStarts({ availability: { weekdays: [1], start: '10:00', end: '11:30' }, durationMinutes: 60, intervalMinutes: 30, horizonDays: 0, now, minStart: now })
        expect(starts.map(formatJstShort)).toEqual(['10/5(月) 10:00', '10/5(月) 10:30'])
    })

    it('日本時間の深夜（UTC では前日）に動いても、日本時間の日付・曜日で数える', () => {
        const lateNight = fromJst(2026, 10, 5, 0, 30) // = 10/4(日) 15:30 UTC
        const starts = generateCandidateStarts({ availability: weekdays, durationMinutes: 60, intervalMinutes: 60, horizonDays: 0, now: lateNight, minStart: lateNight })
        expect(starts.map(formatJstShort)).toEqual(['10/5(月) 10:00', '10/5(月) 11:00', '10/5(月) 12:00'])
    })
})

describe('isFree / mergeBusy（予定と重なるか）', () => {
    const busy = mergeBusy([
        { start: fromJst(2026, 10, 5, 11, 0), end: fromJst(2026, 10, 5, 11, 30) },
        { start: fromJst(2026, 10, 5, 11, 15), end: fromJst(2026, 10, 5, 11, 45) },
    ])

    it('重なる・接している予定はまとめる', () => {
        expect(busy).toHaveLength(1)
        expect(busy[0].end).toEqual(fromJst(2026, 10, 5, 11, 45))
    })

    it('予定と重なる枠は空きではない。ちょうど接するだけなら空き', () => {
        expect(isFree(fromJst(2026, 10, 5, 10, 0), 60, 0, busy)).toBe(true)   // 10:00-11:00
        expect(isFree(fromJst(2026, 10, 5, 11, 0), 60, 0, busy)).toBe(false)  // 11:00-12:00
        expect(isFree(fromJst(2026, 10, 5, 12, 0), 60, 0, busy)).toBe(true)   // 12:00-13:00
    })

    it('前後の余白も含めて確認する', () => {
        expect(isFree(fromJst(2026, 10, 5, 10, 0), 60, 15, busy)).toBe(false) // 余白で 11:15 まで
        expect(isFree(fromJst(2026, 10, 5, 12, 0), 60, 15, busy)).toBe(true)  // 11:45 から 12:00 まで余白 15 分
        expect(isFree(fromJst(2026, 10, 5, 12, 0), 60, 20, busy)).toBe(false)
    })
})

describe('allDayToBusy（終日の予定は日本時間の丸1日）', () => {
    it('終了日は含まない', () => {
        const b = allDayToBusy('2026-10-07', '2026-10-09')!
        expect(b.start).toEqual(fromJst(2026, 10, 7, 0, 0))
        expect(b.end).toEqual(fromJst(2026, 10, 9, 0, 0))
        expect(isFree(fromJst(2026, 10, 8, 10, 0), 60, 0, [b])).toBe(false)
        expect(isFree(fromJst(2026, 10, 9, 10, 0), 60, 0, [b])).toBe(true)
    })
})

describe('validateAvailability', () => {
    it('曜日なし・形式の誤り・短すぎる受付時間を知らせる', () => {
        expect(validateAvailability({ weekdays: [], start: '10:00', end: '18:00' }, 60)).toContain('曜日')
        expect(validateAvailability({ weekdays: [1], start: '10時', end: '18:00' }, 60)).toContain('HH:MM')
        expect(validateAvailability({ weekdays: [1], start: '10:00', end: '10:30' }, 60)).toContain('短く')
        expect(validateAvailability(weekdays, 60)).toBeNull()
    })
})
