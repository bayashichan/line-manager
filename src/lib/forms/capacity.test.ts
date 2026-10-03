import { describe, expect, it } from 'vitest'
import { computeAvailability } from './capacity'

const waitlistForm = { capacity_enabled: true, capacity: 10, full_action: 'waitlist' as const }
const closeForm = { capacity_enabled: true, capacity: 10, full_action: 'close' as const }

describe('computeAvailability', () => {
    it('残席設定がオフなら null', () => {
        expect(computeAvailability({ ...waitlistForm, capacity_enabled: false }, 3, 0)).toBeNull()
        expect(computeAvailability({ ...waitlistForm, capacity: null }, 3, 0)).toBeNull()
    })

    it('席が残っていれば受け付ける', () => {
        expect(computeAvailability(waitlistForm, 7, 0)).toEqual({ capacity: 10, remaining: 3, state: 'open' })
    })

    it('満席なら設定に応じてキャンセル待ち / 締切', () => {
        expect(computeAvailability(waitlistForm, 10, 0)).toEqual({ capacity: 10, remaining: 0, state: 'waitlist' })
        expect(computeAvailability(closeForm, 10, 0)).toEqual({ capacity: 10, remaining: 0, state: 'closed' })
    })

    it('キャンセルで席が空いても、キャンセル待ちの人がいればその人たちの繰り上げ用に取っておく', () => {
        // 定員10・申込8（2人キャンセル）・キャンセル待ち3 → 新しい人は追い越せない
        expect(computeAvailability(waitlistForm, 8, 3)).toEqual({ capacity: 10, remaining: 0, state: 'waitlist' })
        expect(computeAvailability(closeForm, 8, 3)).toEqual({ capacity: 10, remaining: 0, state: 'closed' })
    })

    it('キャンセル待ちの人数より多く席が空けば、残りは新しい申込に出す', () => {
        // 定員10・申込7・キャンセル待ち1 → 1席は繰り上げ用、2席は新しい人へ
        expect(computeAvailability(waitlistForm, 7, 1)).toEqual({ capacity: 10, remaining: 2, state: 'open' })
    })

    it('定員を超えて繰り上げていても残席はマイナスにしない', () => {
        expect(computeAvailability(waitlistForm, 11, 2)).toEqual({ capacity: 10, remaining: 0, state: 'waitlist' })
    })
})
