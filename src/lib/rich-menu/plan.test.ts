import { describe, expect, it } from 'vitest'
import {
    chunk,
    hasUpcomingDisplayPeriod,
    pickAllUsersMenu,
    pickTagMenuId,
    planRichMenuLinks,
    type AllUsersMenuCandidate,
    type UserMenuState,
} from './plan'

const now = new Date('2026-10-01T03:00:00Z')

const menu = (overrides: Partial<AllUsersMenuCandidate> & { id: string }): AllUsersMenuCandidate => ({
    is_default: false,
    image_url: 'https://example.com/menu.jpg',
    display_period_start: null,
    display_period_end: null,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
})

describe('pickAllUsersMenu', () => {
    it('基本のメニューを全員向けにする', () => {
        const result = pickAllUsersMenu([menu({ id: 'a' }), menu({ id: 'b', is_default: true })], now)
        expect(result).toEqual({ id: 'b', reason: 'default' })
    })

    it('表示期間中のメニューは基本のメニューより優先する', () => {
        const result = pickAllUsersMenu([
            menu({ id: 'default', is_default: true }),
            menu({
                id: 'campaign',
                display_period_start: '2026-09-30T00:00:00Z',
                display_period_end: '2026-10-31T14:59:00Z',
            }),
        ], now)
        expect(result).toEqual({ id: 'campaign', reason: 'period' })
    })

    it('期間外・画像なしの期間メニューは使わない', () => {
        const result = pickAllUsersMenu([
            menu({ id: 'default', is_default: true }),
            menu({ id: 'ended', display_period_start: '2026-09-01T00:00:00Z', display_period_end: '2026-09-30T00:00:00Z' }),
            menu({ id: 'future', display_period_start: '2026-10-02T00:00:00Z', display_period_end: '2026-10-31T00:00:00Z' }),
            menu({ id: 'no-image', image_url: null, display_period_start: '2026-09-30T00:00:00Z', display_period_end: '2026-10-31T00:00:00Z' }),
        ], now)
        expect(result).toEqual({ id: 'default', reason: 'default' })
    })

    it('期間メニューが重なったら新しく作ったものを使う', () => {
        const period = { display_period_start: '2026-09-30T00:00:00Z', display_period_end: '2026-10-31T00:00:00Z' }
        const result = pickAllUsersMenu([
            menu({ id: 'old', created_at: '2026-09-01T00:00:00Z', ...period }),
            menu({ id: 'new', created_at: '2026-09-20T00:00:00Z', ...period }),
        ], now)
        expect(result?.id).toBe('new')
    })

    it('is_default がなければチャンネルに記録したデフォルトを使い、どちらもなければ null', () => {
        expect(pickAllUsersMenu([menu({ id: 'a' })], now, 'a')).toEqual({ id: 'a', reason: 'default' })
        expect(pickAllUsersMenu([menu({ id: 'a' })], now, 'deleted')).toBeNull()
        expect(pickAllUsersMenu([menu({ id: 'a' })], now)).toBeNull()
    })
})

describe('hasUpcomingDisplayPeriod', () => {
    it('期間中・これからの期間は true、終わった期間や未設定は false', () => {
        expect(hasUpcomingDisplayPeriod({ display_period_start: '2026-09-30T00:00:00Z', display_period_end: '2026-10-31T00:00:00Z' }, now)).toBe(true)
        expect(hasUpcomingDisplayPeriod({ display_period_start: '2026-11-01T00:00:00Z', display_period_end: '2026-11-30T00:00:00Z' }, now)).toBe(true)
        expect(hasUpcomingDisplayPeriod({ display_period_start: '2026-09-01T00:00:00Z', display_period_end: '2026-09-30T00:00:00Z' }, now)).toBe(false)
        expect(hasUpcomingDisplayPeriod({ display_period_start: null, display_period_end: null }, now)).toBe(false)
    })
})

describe('pickTagMenuId', () => {
    const usable = new Set(['vip-menu', 'student-menu'])

    it('優先度が高いタグのメニューを選ぶ', () => {
        expect(pickTagMenuId([
            { tagId: 't1', linkedMenuId: 'student-menu', priority: 1 },
            { tagId: 't2', linkedMenuId: 'vip-menu', priority: 10 },
        ], usable)).toBe('vip-menu')
    })

    it('メニューのないタグ・LINEに未反映のメニューは候補にしない', () => {
        expect(pickTagMenuId([
            { tagId: 't1', linkedMenuId: null, priority: 100 },
            { tagId: 't2', linkedMenuId: 'not-published', priority: 50 },
            { tagId: 't3', linkedMenuId: 'student-menu', priority: 0 },
        ], usable)).toBe('student-menu')
    })

    it('候補がなければ null（全員向けに従う）', () => {
        expect(pickTagMenuId([], usable)).toBeNull()
        expect(pickTagMenuId([{ tagId: 't1', linkedMenuId: 'not-published', priority: 1 }], usable)).toBeNull()
    })

    it('同じ優先度なら並び順に関係なく同じ結果になる', () => {
        const a = { tagId: 'a', linkedMenuId: 'vip-menu', priority: 5 }
        const b = { tagId: 'b', linkedMenuId: 'student-menu', priority: 5 }
        expect(pickTagMenuId([a, b], usable)).toBe(pickTagMenuId([b, a], usable))
    })
})

describe('planRichMenuLinks', () => {
    const user = (id: string, currentMenuId: string | null, targetMenuId: string | null): UserMenuState => ({
        id,
        lineUserId: `U${id}`,
        currentMenuId,
        targetMenuId,
    })

    it('記録と同じ人には送らず、変わる人だけリンク・アンリンクする', () => {
        const plan = planRichMenuLinks([
            user('same-tag', 'vip', 'vip'),
            user('same-all', null, null),
            user('to-vip', null, 'vip'),
            // 以前の仕組みで基本のメニューを個別に付けていた人は、外して全員向けに従わせる
            user('legacy-default', 'old-default', null),
        ])
        expect([...plan.link.entries()].map(([menuId, users]) => [menuId, users.map(u => u.id)]))
            .toEqual([['vip', ['to-vip']]])
        expect(plan.unlink.map(u => u.id)).toEqual(['legacy-default'])
    })

    it('force なら記録が同じでも全員に送り直す', () => {
        const plan = planRichMenuLinks([
            user('same-tag', 'vip', 'vip'),
            user('same-all', null, null),
        ], { force: true })
        expect(plan.link.get('vip')?.map(u => u.id)).toEqual(['same-tag'])
        expect(plan.unlink.map(u => u.id)).toEqual(['same-all'])
    })

    it('作り直したメニューの人は記録が同じでも付け直す', () => {
        const plan = planRichMenuLinks([
            user('a', 'vip', 'vip'),
            user('b', 'student', 'student'),
        ], { relinkMenuIds: new Set(['vip']) })
        expect([...plan.link.keys()]).toEqual(['vip'])
        expect(plan.unlink).toEqual([])
    })
})

describe('chunk', () => {
    it('指定した件数ずつに分ける', () => {
        expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
        expect(chunk([], 500)).toEqual([])
    })
})
