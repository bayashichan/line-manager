import { describe, expect, it } from 'vitest'
import { formatChatDayLabel, formatChatTime, jstDayKey } from './chat-date'

// 2026-11-04(水) 12:00 JST
const NOW = new Date('2026-11-04T12:00:00+09:00')

describe('jstDayKey', () => {
    it('日本時間の日付で区切る（UTCでは前日でも、日本時間で同じ日なら同じ）', () => {
        expect(jstDayKey(new Date('2026-11-04T00:10:00+09:00'))).toBe('2026-11-04')
        expect(jstDayKey(new Date('2026-11-04T23:59:00+09:00'))).toBe('2026-11-04')
        expect(jstDayKey(new Date('2026-11-03T23:59:00+09:00'))).toBe('2026-11-03')
    })
})

describe('formatChatDayLabel', () => {
    it('今日・昨日は日付に添えて出す', () => {
        expect(formatChatDayLabel(new Date('2026-11-04T00:05:00+09:00'), NOW)).toBe('11月4日(水) 今日')
        expect(formatChatDayLabel(new Date('2026-11-03T23:55:00+09:00'), NOW)).toBe('11月3日(火) 昨日')
    })

    it('それより前は日付と曜日だけ', () => {
        expect(formatChatDayLabel(new Date('2026-10-28T10:00:00+09:00'), NOW)).toBe('10月28日(水)')
    })

    it('年が違うときは年も出す', () => {
        expect(formatChatDayLabel(new Date('2025-12-31T10:00:00+09:00'), NOW)).toBe('2025年12月31日(水)')
    })
})

describe('formatChatTime', () => {
    it('日本時間の HH:MM', () => {
        expect(formatChatTime(new Date('2026-11-04T09:05:00+09:00'))).toBe('09:05')
        expect(formatChatTime(new Date('2026-11-03T15:30:00Z'))).toBe('00:30')
    })
})
