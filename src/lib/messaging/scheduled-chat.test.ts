import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { createAdminClient } from '@/lib/supabase/server'
import {
    MAX_SCHEDULE_AHEAD_DAYS,
    ScheduledChatError,
    cancelScheduledChatMessage,
    deliverScheduledChatMessage,
    normalizeScheduledContent,
    parseSendAt,
    processDueScheduledChatMessages,
} from './scheduled-chat'

/*
 * DB（Supabase）と LINE API を手元の偽物に置き換えて、
 * 「予約した時刻に1回だけ送られるか」「取り消し・ブロック・失敗が正しく残るか」を確かめる。
 */

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}

/** テストで使う範囲だけを実装した Supabase のクエリビルダー（結合先は行にあらかじめ持たせておく） */
class FakeQuery {
    private filters: ((row: Row) => boolean)[] = []
    private op: 'select' | 'update' | 'insert' = 'select'
    private payload: Row | Row[] = {}
    private returning = false
    private single = false

    constructor(private table: string) { }

    select() {
        if (this.op !== 'select') this.returning = true
        return this
    }
    insert(payload: Row | Row[]) {
        this.op = 'insert'
        this.payload = payload
        return this
    }
    update(payload: Row) {
        this.op = 'update'
        this.payload = payload
        return this
    }
    eq(column: string, value: unknown) {
        this.filters.push(row => row[column] === value)
        return this
    }
    in(column: string, values: unknown[]) {
        this.filters.push(row => values.includes(row[column]))
        return this
    }
    lte(column: string, value: string) {
        this.filters.push(row => new Date(String(row[column])).getTime() <= new Date(value).getTime())
        return this
    }
    order() {
        return this
    }
    limit() {
        return this
    }
    maybeSingle() {
        this.single = true
        return this
    }
    then<T>(resolve: (value: { data: unknown; error: unknown }) => T) {
        return Promise.resolve(this.execute()).then(resolve)
    }
    private execute(): { data: unknown; error: unknown } {
        const table = (tables[this.table] ??= [])
        if (this.op === 'insert') {
            table.push(...(Array.isArray(this.payload) ? this.payload : [this.payload]))
            return { data: null, error: null }
        }
        const rows = table.filter(row => this.filters.every(f => f(row)))
        if (this.op === 'update') {
            rows.forEach(row => Object.assign(row, this.payload))
            return { data: this.returning ? rows.map(r => ({ ...r })) : null, error: null }
        }
        const data = rows.map(r => ({ ...r }))
        return { data: this.single ? data[0] ?? null : data, error: null }
    }
}

const supabase = { from: (table: string) => new FakeQuery(table) } as unknown as ReturnType<typeof createAdminClient>

/** 偽の LINE。送ったメッセージを記録する */
const pushed: { to: string; messages: object[] }[] = []
let lineFailure: Error | null = null

vi.mock('@/lib/line', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/line')>()
    return {
        ...actual,
        LineClient: class {
            async pushMessage(to: string, messages: object[]) {
                if (lineFailure) throw lineFailure
                pushed.push({ to, messages })
            }
        },
    }
})

const NOW = new Date('2026-10-01T03:00:00.000Z') // 10/1 12:00 JST

function addScheduled(id: string, overrides: Row = {}): Row {
    const row: Row = {
        id,
        channel_id: 'ch1',
        line_user_id: `friend-${id}`,
        content: [{ type: 'text', text: `予約 ${id}` }],
        send_at: '2026-10-01T02:55:00.000Z', // 5分前
        status: 'pending',
        line_users: { line_user_id: `U-${id}`, is_blocked: false },
        channels: { channel_access_token: 'token' },
        ...overrides,
    }
    tables.scheduled_chat_messages.push(row)
    return row
}

beforeEach(() => {
    for (const key of Object.keys(tables)) delete tables[key]
    tables.scheduled_chat_messages = []
    tables.chat_messages = []
    tables.line_users = []
    pushed.length = 0
    lineFailure = null
})

describe('processDueScheduledChatMessages（定期処理からの送信）', () => {
    it('時刻を過ぎた予約だけを送り、チャット履歴に残す', async () => {
        const due = addScheduled('a')
        const future = addScheduled('b', { send_at: '2026-10-01T03:30:00.000Z' })
        const cancelled = addScheduled('c', { status: 'cancelled' })

        const result = await processDueScheduledChatMessages(supabase, NOW)

        expect(result).toEqual({ sent: 1, failed: 0 })
        expect(pushed).toEqual([{ to: 'U-a', messages: [{ type: 'text', text: '予約 a' }] }])
        expect(due.status).toBe('sent')
        expect(due.sent_at).toBeTruthy()
        expect(future.status).toBe('pending')
        expect(cancelled.status).toBe('cancelled')
        expect(tables.chat_messages).toEqual([
            expect.objectContaining({ line_user_id: 'friend-a', sender: 'admin', content: { type: 'text', text: '予約 a' } }),
        ])
    })

    it('ブロックされている友だちには送らず、理由を残す', async () => {
        const row = addScheduled('a', { line_users: { line_user_id: 'U-a', is_blocked: true } })

        expect(await processDueScheduledChatMessages(supabase, NOW)).toEqual({ sent: 0, failed: 1 })
        expect(pushed).toEqual([])
        expect(row.status).toBe('failed')
        expect(row.error_message).toContain('ブロック')
    })

    it('LINE に送れなかったときは失敗として理由を残す', async () => {
        lineFailure = new Error('The request body has 1 error(s)')
        const row = addScheduled('a')

        expect(await processDueScheduledChatMessages(supabase, NOW)).toEqual({ sent: 0, failed: 1 })
        expect(row.status).toBe('failed')
        expect(row.error_message).toContain('The request body has 1 error(s)')
        expect(tables.chat_messages).toEqual([])
    })
})

describe('deliverScheduledChatMessage（QStash から予約時刻に1件送る）', () => {
    it('QStash と定期処理の両方から呼ばれても、送るのは1回だけ', async () => {
        addScheduled('a')

        expect(await deliverScheduledChatMessage(supabase, 'a', NOW)).toBe('sent')
        expect(await processDueScheduledChatMessages(supabase, NOW)).toEqual({ sent: 0, failed: 0 })
        expect(await deliverScheduledChatMessage(supabase, 'a', NOW)).toBe('skipped')
        expect(pushed).toHaveLength(1)
    })

    it('取り消した予約は送らない', async () => {
        addScheduled('a', { send_at: '2026-10-01T04:00:00.000Z' })

        expect(await cancelScheduledChatMessage(supabase, 'a')).toBe('cancelled')
        expect(await deliverScheduledChatMessage(supabase, 'a', new Date('2026-10-01T04:00:00.000Z'))).toBe('skipped')
        expect(pushed).toEqual([])
    })

    it('予約時刻の1分前までなら送る（時計のずれで定期処理まで待たせない）が、それより前は送らない', async () => {
        addScheduled('early', { send_at: '2026-10-01T03:05:00.000Z' })
        addScheduled('near', { send_at: '2026-10-01T03:00:30.000Z' })

        expect(await deliverScheduledChatMessage(supabase, 'early', NOW)).toBe('skipped')
        expect(await deliverScheduledChatMessage(supabase, 'near', NOW)).toBe('sent')
        expect(pushed.map(p => p.to)).toEqual(['U-near'])
    })

    it('存在しない予約は何もしない', async () => {
        expect(await deliverScheduledChatMessage(supabase, 'missing', NOW)).toBe('skipped')
    })
})

describe('cancelScheduledChatMessage（取り消し）', () => {
    it('送信中・送信済みは取り消せない。送れなかった予約は閉じられる', async () => {
        addScheduled('sending', { status: 'sending' })
        addScheduled('sent', { status: 'sent' })
        const failed = addScheduled('failed', { status: 'failed' })

        expect(await cancelScheduledChatMessage(supabase, 'sending')).toBe('not_cancellable')
        expect(await cancelScheduledChatMessage(supabase, 'sent')).toBe('not_cancellable')
        expect(await cancelScheduledChatMessage(supabase, 'failed')).toBe('cancelled')
        expect(failed.status).toBe('cancelled')
    })
})

describe('normalizeScheduledContent（チャットの送信予約の内容）', () => {
    it('テキスト・画像・動画を LINE のメッセージにする（管理画面用の項目は落とす）', () => {
        const result = normalizeScheduledContent([
            { type: 'text', text: '明日の面談よろしくお願いします' },
            { type: 'image', originalContentUrl: 'https://example.com/a.jpg', previewImageUrl: 'https://example.com/a_s.jpg', extra: 'x' },
            { type: 'video', originalContentUrl: 'https://example.com/v.mp4', previewImageUrl: 'https://example.com/v.jpg' },
        ])
        expect(result).toEqual([
            { type: 'text', text: '明日の面談よろしくお願いします' },
            { type: 'image', originalContentUrl: 'https://example.com/a.jpg', previewImageUrl: 'https://example.com/a_s.jpg' },
            { type: 'video', originalContentUrl: 'https://example.com/v.mp4', previewImageUrl: 'https://example.com/v.jpg' },
        ])
    })

    it('空・多すぎる・未対応の種別・空のテキストは受け付けない', () => {
        expect(() => normalizeScheduledContent([])).toThrow(ScheduledChatError)
        expect(() => normalizeScheduledContent(undefined)).toThrow(ScheduledChatError)
        expect(() => normalizeScheduledContent(Array(6).fill({ type: 'text', text: 'a' }))).toThrow('5通まで')
        expect(() => normalizeScheduledContent([{ type: 'flex', altText: 'x', contents: {} }])).toThrow(ScheduledChatError)
        expect(() => normalizeScheduledContent([{ type: 'text', text: '   ' }])).toThrow(ScheduledChatError)
    })

    it('https でない画像の URL は受け付けない', () => {
        expect(() =>
            normalizeScheduledContent([{ type: 'image', originalContentUrl: 'http://example.com/a.jpg' }])
        ).toThrow(ScheduledChatError)
    })
})

describe('parseSendAt（チャットの送信予約の日時）', () => {
    const now = new Date('2026-10-01T03:00:00.000Z') // 10/1 12:00 JST

    it('未来の日時はそのまま受け付ける（日本時間の指定も可）', () => {
        expect(parseSendAt('2026-10-02T09:00:00+09:00', now)).toEqual(new Date('2026-10-02T00:00:00.000Z'))
    })

    it('未入力・不正・過去・現在は受け付けない', () => {
        expect(() => parseSendAt('', now)).toThrow('送信日時を指定してください')
        expect(() => parseSendAt(undefined, now)).toThrow(ScheduledChatError)
        expect(() => parseSendAt('あした', now)).toThrow('送信日時が正しくありません')
        expect(() => parseSendAt('2026-10-01T02:59:00.000Z', now)).toThrow('過去の日時は指定できません')
        expect(() => parseSendAt(now.toISOString(), now)).toThrow('過去の日時は指定できません')
    })

    it(`${MAX_SCHEDULE_AHEAD_DAYS}日より先は受け付けない`, () => {
        const limit = new Date(now.getTime() + MAX_SCHEDULE_AHEAD_DAYS * 24 * 60 * 60 * 1000)
        expect(parseSendAt(limit.toISOString(), now)).toEqual(limit)
        expect(() => parseSendAt(new Date(limit.getTime() + 60000).toISOString(), now)).toThrow('1年以内')
    })
})
