import { describe, expect, it } from 'vitest'
import { fromJst } from '@/lib/reminders/timing'
import { buildOfferMessage, buildOfferOptions, matchesTriggerKeyword, parseOfferAnswer } from './offer'

const slots = [
    { id: 's1', start_at: fromJst(2026, 10, 3, 10, 0).toISOString(), status: 'open' },
    { id: 's2', start_at: fromJst(2026, 10, 4, 14, 0).toISOString(), status: 'open' },
    { id: 's3', start_at: fromJst(2026, 10, 6, 19, 30).toISOString(), status: 'open' },
]
const options = buildOfferOptions(slots, { other: '別の日程を希望', decline: '今回は見送る' })

describe('buildOfferOptions / buildOfferMessage', () => {
    it('枠 → 別の日程 → 見送る の順に番号を振る', () => {
        expect(options.map(o => `${o.no}:${o.label}`)).toEqual([
            '1:10/3(土) 10:00',
            '2:10/4(日) 14:00',
            '3:10/6(火) 19:30',
            '4:別の日程を希望',
            '5:今回は見送る',
        ])
    })

    it('番号付きの一覧と、タップで選べるボタンを付ける', () => {
        const message = buildOfferMessage('山田さん、候補日です。', options) as {
            text: string
            quickReply: { items: { action: { label: string; text: string } }[] }
        }
        expect(message.text).toContain('1. 10/3(土) 10:00\n2. 10/4(日) 14:00')
        expect(message.text).toContain('5. 今回は見送る')
        expect(message.quickReply.items.map(i => i.action.text)).toEqual([
            '1 10/3(土) 10:00', '2 10/4(日) 14:00', '3 10/6(火) 19:30', '4 別の日程を希望', '5 今回は見送る',
        ])
        expect(message.quickReply.items.every(i => i.action.label.length <= 20)).toBe(true)
    })

    it('埋まった枠は一覧とボタンから外す（番号はずらさない）', () => {
        const partial = buildOfferOptions([slots[0], { ...slots[1], status: 'booked' }, slots[2]], { other: '別', decline: '見送る' })
        const message = buildOfferMessage('候補', partial) as { text: string; quickReply: { items: unknown[] } }
        expect(message.text).not.toContain('2. ')
        expect(message.text).toContain('3. 10/6(火) 19:30')
        expect(message.quickReply.items).toHaveLength(4)
    })
})

describe('parseOfferAnswer（返事から選択肢を読み取る）', () => {
    const pick = (text: string) => parseOfferAnswer(text, options)?.no ?? null

    it('番号だけ・全角・丸数字・「番」付き', () => {
        expect(pick('1')).toBe(1)
        expect(pick('２')).toBe(2)
        expect(pick('③')).toBe(3)
        expect(pick('1番')).toBe(1)
        expect(pick(' 2. ')).toBe(2)
        expect(pick('4')).toBe(4)
    })

    it('ボタンの文言・選択肢のラベル', () => {
        expect(pick('1 10/3(土) 10:00')).toBe(1)
        expect(pick('5 今回は見送る')).toBe(5)
        expect(pick('別の日程を希望')).toBe(4)
    })

    it('番号のあとに別の文が続くものや、範囲外の番号は読み取らない', () => {
        expect(pick('1時間くらいですか？')).toBeNull()
        expect(pick('10:00')).toBeNull()
        expect(pick('9')).toBeNull()
        expect(pick('よろしくお願いします')).toBeNull()
        expect(pick('')).toBeNull()
    })
})

describe('matchesTriggerKeyword（「個別」などのきっかけ）', () => {
    it('完全一致（前後の空白・末尾の記号は無視）', () => {
        expect(matchesTriggerKeyword('個別', ['個別'])).toBe(true)
        expect(matchesTriggerKeyword(' 個別！', ['個別'])).toBe(true)
        expect(matchesTriggerKeyword('個別。', ['個別'])).toBe(true)
    })

    it('文の一部に含まれるだけでは反応しない', () => {
        expect(matchesTriggerKeyword('個別相談の料金は？', ['個別'])).toBe(false)
        expect(matchesTriggerKeyword('', ['個別'])).toBe(false)
        expect(matchesTriggerKeyword('個別', [])).toBe(false)
    })

    it('複数のキーワード', () => {
        expect(matchesTriggerKeyword('面談希望', ['個別', '面談希望'])).toBe(true)
    })
})
