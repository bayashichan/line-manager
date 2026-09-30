import { describe, expect, it } from 'vitest'
import {
    applyReminderPlaceholders,
    computeSendAt,
    describeReminderTiming,
    formatJstDateTime,
    formatJstShort,
    fromJst,
    planDeliveries,
} from './timing'

// 面談: 2026-10-03(土) 10:00 JST = 01:00 UTC
const target = fromJst(2026, 10, 3, 10, 0)

const dayTime = (offset_days: number, send_hour: number | null, send_minute = 0) =>
    ({ timing_type: 'day_time' as const, offset_days, send_hour, send_minute, offset_minutes: 0 })
const relative = (offset_minutes: number) =>
    ({ timing_type: 'relative' as const, offset_days: 0, send_hour: null, send_minute: 0, offset_minutes })

describe('computeSendAt（予定の日時を基準にした送信時刻・日本時間）', () => {
    it('N日前の HH:MM', () => {
        expect(computeSendAt(target, dayTime(-3, 20))).toEqual(fromJst(2026, 9, 30, 20, 0))
        expect(computeSendAt(target, dayTime(-1, 20, 30))).toEqual(fromJst(2026, 10, 2, 20, 30))
    })

    it('当日・翌日', () => {
        expect(computeSendAt(target, dayTime(0, 8))).toEqual(fromJst(2026, 10, 3, 8, 0))
        expect(computeSendAt(target, dayTime(1, 10))).toEqual(fromJst(2026, 10, 4, 10, 0))
    })

    it('時刻なしは予定と同じ時刻', () => {
        expect(computeSendAt(target, dayTime(-2, null))).toEqual(fromJst(2026, 10, 1, 10, 0))
    })

    it('何分前・何時間後', () => {
        expect(computeSendAt(target, relative(-60))).toEqual(fromJst(2026, 10, 3, 9, 0))
        expect(computeSendAt(target, relative(90))).toEqual(fromJst(2026, 10, 3, 11, 30))
    })

    it('日本時間の深夜（UTC では前日）の予定でも日本時間の日付で数える', () => {
        const late = fromJst(2026, 10, 3, 0, 30) // = 10/2 15:30 UTC
        expect(computeSendAt(late, dayTime(-1, 20))).toEqual(fromJst(2026, 10, 2, 20, 0))
    })
})

describe('planDeliveries（登録時の送信予定）', () => {
    const steps = [
        { step_order: 1, ...dayTime(-3, 20) },   // 事前質問
        { step_order: 2, ...dayTime(-2, 20) },   // 録音のお願い
        { step_order: 3, ...dayTime(-1, 20) },   // 前日連絡
        { step_order: 4, ...relative(-60) },     // 1時間前
        { step_order: 5, ...dayTime(1, 10) },    // 翌日のお礼
    ]

    it('十分前に登録すれば全部予定どおり', () => {
        const plan = planDeliveries(target, steps, fromJst(2026, 9, 25, 12, 0), true)
        expect(plan.map(p => p.status)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending'])
        expect(plan.some(p => p.catchUp)).toBe(false)
    })

    it('直前に登録したら、過ぎた事前案内はすぐ送る（送信時刻は登録時刻）', () => {
        const now = fromJst(2026, 10, 1, 21, 0) // 2日前の夜（事前質問と録音のお願いの時刻を過ぎている）
        const plan = planDeliveries(target, steps, now, true)
        expect(plan.map(p => [p.status, p.catchUp])).toEqual([
            ['pending', true],
            ['pending', true],
            ['pending', false],
            ['pending', false],
            ['pending', false],
        ])
        expect(plan[0].sendAt).toEqual(now)
    })

    it('すぐ送らない設定なら、過ぎたものは送らない', () => {
        const plan = planDeliveries(target, steps, fromJst(2026, 10, 1, 21, 0), false)
        expect(plan.map(p => p.status)).toEqual(['skipped', 'skipped', 'pending', 'pending', 'pending'])
    })

    it('予定を過ぎてから登録したら、予定前の案内は送らない（予定後のものだけ）', () => {
        const plan = planDeliveries(target, steps, fromJst(2026, 10, 3, 18, 0), true)
        expect(plan.map(p => p.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'pending'])
    })
})

describe('表記と差し込み', () => {
    it('日時の表記', () => {
        expect(formatJstDateTime(target)).toBe('10月3日(土) 10:00')
        expect(formatJstShort(target)).toBe('10/3(土) 10:00')
    })

    it('タイミングの表記', () => {
        expect(describeReminderTiming(dayTime(-3, 20))).toBe('3日前 20:00')
        expect(describeReminderTiming(dayTime(-1, 9, 5))).toBe('前日 9:05')
        expect(describeReminderTiming(dayTime(0, 8))).toBe('当日 8:00')
        expect(describeReminderTiming(relative(-60))).toBe('1時間前')
        expect(describeReminderTiming(relative(-90))).toBe('1時間30分前')
        expect(describeReminderTiming(relative(30))).toBe('30分後')
    })

    it('{name}・{日時}・{予定} をテキストだけ置き換える', () => {
        const out = applyReminderPlaceholders(
            [
                { type: 'text', text: '{name}さん、{予定}は{日時}です（{日付} {時刻}）' },
                { type: 'image', originalContentUrl: 'https://x/{name}.png' },
            ],
            { name: '山田', target, label: '初回無料面談' }
        )
        expect(out[0].text).toBe('山田さん、初回無料面談は10月3日(土) 10:00です（10月3日(土) 10:00）')
        expect(out[1].originalContentUrl).toBe('https://x/{name}.png')
    })
})
