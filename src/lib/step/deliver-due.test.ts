import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * DB（Supabase）と LINE API を手元の偽物に置き換えて、
 * 「送信時刻を迎えた人に、1回の実行で何通送るか」を確かめる。
 */

type Row = Record<string, unknown>

const { db, pushes } = vi.hoisted(() => ({
    db: { tables: {} as Record<string, Row[]> },
    pushes: [] as string[],
}))

/** テストで使う範囲だけを実装した Supabase のクエリビルダー */
class FakeQuery {
    private filters: ((row: Row) => boolean)[] = []
    private op: 'select' | 'update' | 'insert' = 'select'
    private payload: Row = {}
    private returning = false
    private orders: { column: string; ascending: boolean }[] = []
    private limit_: number | null = null

    constructor(private table: string) { }

    select() {
        if (this.op !== 'select') this.returning = true
        return this
    }
    update(payload: Row) {
        this.op = 'update'
        this.payload = payload
        return this
    }
    insert(payload: Row) {
        this.op = 'insert'
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
        this.filters.push(row => String(row[column]) <= value)
        return this
    }
    order(column: string, options: { ascending?: boolean } = {}) {
        this.orders.push({ column, ascending: options.ascending !== false })
        return this
    }
    limit(count: number) {
        this.limit_ = count
        return this
    }

    then<T>(resolve: (value: { data: unknown; error: unknown }) => T) {
        return Promise.resolve(this.execute()).then(resolve)
    }

    private execute(): { data: unknown; error: unknown } {
        const table = (db.tables[this.table] ??= [])

        if (this.op === 'insert') {
            table.push({ ...this.payload })
            return { data: null, error: null }
        }

        let rows = table.filter(row => this.filters.every(f => f(row)))

        if (this.op === 'update') {
            rows.forEach(row => Object.assign(row, this.payload))
            return { data: this.returning ? rows.map(r => ({ ...r })) : null, error: null }
        }

        rows = [...rows].sort((a, b) => {
            for (const { column, ascending } of this.orders) {
                const diff = String(a[column]).localeCompare(String(b[column]))
                if (diff !== 0) return ascending ? diff : -diff
            }
            return 0
        })
        if (this.limit_ !== null) rows = rows.slice(0, this.limit_)

        return { data: rows.map(row => this.withRelations(row)), error: null }
    }

    /** step_executions の select では、シナリオ（ステップ・チャンネル付き）と友だちを付けて返す */
    private withRelations(row: Row): Row {
        if (this.table !== 'step_executions') return { ...row }
        const scenario = db.tables.step_scenarios.find(s => s.id === row.scenario_id)!
        const user = db.tables.line_users.find(u => u.id === row.line_user_id)!
        return {
            ...row,
            step_scenarios: {
                ...scenario,
                step_messages: db.tables.step_messages.filter(m => m.scenario_id === scenario.id),
                channels: db.tables.channels.find(c => c.id === scenario.channel_id),
            },
            line_users: { line_user_id: user.line_user_id, display_name: user.display_name },
        }
    }
}

vi.mock('@/lib/supabase/server', () => ({
    createAdminClient: () => ({ from: (table: string) => new FakeQuery(table) }),
}))

vi.mock('@/lib/line', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/line')>()
    return {
        ...actual,
        LineClient: class {
            async pushMessage(to: string) {
                pushes.push(to)
            }
        },
    }
})

import { deliverDueStepMessages } from './deliver-due'

const HOUR = 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()

/** count 人がステップ1の送信時刻を迎えている状態を作る。ステップ2は secondStepDelayMinutes 後 */
function seed(count: number, secondStepDelayMinutes: number) {
    const now = Date.now()
    db.tables = {
        channels: [{ id: 'c1', channel_access_token: 'token' }],
        step_scenarios: [{ id: 's1', channel_id: 'c1' }],
        step_messages: [
            { id: 'm1', scenario_id: 's1', step_order: 1, delay_minutes: 0, send_hour: null, send_minute: 0, content: [{ type: 'text', text: '1通目' }] },
            { id: 'm2', scenario_id: 's1', step_order: 2, delay_minutes: secondStepDelayMinutes, send_hour: null, send_minute: 0, content: [{ type: 'text', text: '2通目' }] },
        ],
        line_users: Array.from({ length: count }, (_, i) => ({ id: `lu${i}`, line_user_id: `U${i}`, display_name: `名前${i}` })),
        step_executions: Array.from({ length: count }, (_, i) => ({
            id: `e${String(i).padStart(4, '0')}`,
            scenario_id: 's1',
            line_user_id: `lu${i}`,
            current_step: 1,
            status: 'active',
            started_at: iso(now - HOUR),
            next_send_at: iso(now - HOUR + i),
        })),
        chat_messages: [],
    }
}

const executions = () => db.tables.step_executions

beforeEach(() => {
    pushes.length = 0
})

describe('deliverDueStepMessages', () => {
    it('同じ時刻に送る人が多くても、1回の実行で50件より多く送る', async () => {
        seed(300, 24 * 60)

        const result = await deliverDueStepMessages()

        expect(result).toEqual({ ok: true, processed: 300 })
        expect(new Set(pushes).size).toBe(300)
        expect(pushes).toHaveLength(300)
        // 全員ステップ2へ進み、次の送信は1日後
        expect(executions().every(e => e.current_step === 2 && String(e.next_send_at) > iso(Date.now()))).toBe(true)
    })

    it('次のステップの時刻がもう過ぎていても、同じ回には続けて送らない', async () => {
        // ステップ2も開始直後（＝もう過ぎている）
        seed(120, 0)

        await deliverDueStepMessages()
        expect(pushes).toHaveLength(120)
        expect(new Set(pushes).size).toBe(120)
        expect(executions().every(e => e.current_step === 2 && e.status === 'active')).toBe(true)

        // 次の回でステップ2を送り、完了になる
        await deliverDueStepMessages()
        expect(pushes).toHaveLength(240)
        expect(executions().every(e => e.status === 'completed')).toBe(true)
    })

    it('送信時刻前の人には送らない', async () => {
        seed(3, 24 * 60)
        executions()[1].next_send_at = iso(Date.now() + HOUR)

        const result = await deliverDueStepMessages()

        expect(result.processed).toBe(2)
        expect(pushes.sort()).toEqual(['U0', 'U2'])
    })

    it('時間の目安を過ぎたら、残りは送信の権利を取らずに次の回へ回す', async () => {
        seed(10, 24 * 60)

        const result = await deliverDueStepMessages({ timeBudgetMs: 0 })

        expect(result).toEqual({ ok: true, processed: 0 })
        expect(pushes).toHaveLength(0)
        expect(executions().every(e => e.current_step === 1 && String(e.next_send_at) <= iso(Date.now()))).toBe(true)
    })
})
