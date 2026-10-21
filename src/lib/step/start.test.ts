import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { startStepExecutions, USER_ID_LOOKUP_CHUNK } from './start'

/*
 * step_executions だけを持つ偽の Supabase。
 * 本物と同じく (scenario_id, line_user_id) の一意制約があり、まとめて登録したうち1件でも
 * 当たると全体が登録されない。
 */

type Row = Record<string, unknown>
type Result = { data?: unknown; error: { code?: string; message: string } | null }

function createFakeDb(initial: Row[], options: { failLookup?: boolean; insertErrorCode?: string } = {}) {
    const rows = initial.map(r => ({ ...r }))
    const stats = { maxInSize: 0, insertCalls: 0 }

    const select = () => {
        const filters: ((row: Row) => boolean)[] = []
        const query = {
            eq(column: string, value: unknown) {
                filters.push(row => row[column] === value)
                return query
            },
            in(column: string, values: unknown[]) {
                stats.maxInSize = Math.max(stats.maxInSize, values.length)
                filters.push(row => values.includes(row[column]))
                return query
            },
            then<T>(resolve: (value: Result) => T) {
                const result: Result = options.failLookup
                    ? { data: null, error: { message: 'lookup failed' } }
                    : { data: rows.filter(row => filters.every(f => f(row))).map(r => ({ ...r })), error: null }
                return Promise.resolve(result).then(resolve)
            },
        }
        return query
    }

    const insert = async (payload: Row | Row[]): Promise<Result> => {
        stats.insertCalls++
        if (options.insertErrorCode) return { error: { code: options.insertErrorCode, message: 'insert failed' } }
        const list = Array.isArray(payload) ? payload : [payload]
        const conflict = list.some(n =>
            rows.some(r => r.scenario_id === n.scenario_id && r.line_user_id === n.line_user_id)
        )
        if (conflict) return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
        rows.push(...list.map(r => ({ ...r })))
        return { error: null }
    }

    const client = { from: () => ({ select, insert }) } as unknown as SupabaseClient
    return { client, rows, stats }
}

const users = (count: number) => Array.from({ length: count }, (_, i) => `u${i}`)
const params = (lineUserIds: string[]) => ({
    scenarioId: 's1',
    lineUserIds,
    currentStep: 1,
    nextSendAt: '2026-10-21T00:00:00.000Z',
})

describe('startStepExecutions', () => {
    it('大人数でも全員に登録し、実行中・実行済みの人は開始しない', async () => {
        const { client, rows, stats } = createFakeDb([
            { scenario_id: 's1', line_user_id: 'u0', status: 'active' },
            { scenario_id: 's1', line_user_id: 'u1', status: 'active' },
            { scenario_id: 's1', line_user_id: 'u2', status: 'active' },
            // 完了済みの人は一意制約に当たる（まとめて登録したまとまりは1件ずつ登録し直す）
            { scenario_id: 's1', line_user_id: 'u3', status: 'completed' },
            { scenario_id: 's1', line_user_id: 'u1200', status: 'completed' },
            // 別のシナリオの実行は関係ない
            { scenario_id: 's2', line_user_id: 'u4', status: 'active' },
        ])

        const result = await startStepExecutions(client, params(users(1500)))

        expect(result).toEqual({ created: 1495, skipped: 5, failed: 0 })
        const s1 = rows.filter(r => r.scenario_id === 's1')
        expect(s1).toHaveLength(1500)
        expect(new Set(s1.map(r => r.line_user_id)).size).toBe(1500)
        // IN 句に載せる人数は URL 長の上限に当たらない数まで
        expect(stats.maxInSize).toBeLessThanOrEqual(USER_ID_LOOKUP_CHUNK)
    })

    it('同じ人が重複して渡されても1回だけ数える', async () => {
        const { client, rows } = createFakeDb([])
        const result = await startStepExecutions(client, params(['u1', 'u1', 'u2']))
        expect(result).toEqual({ created: 2, skipped: 0, failed: 0 })
        expect(rows).toHaveLength(2)
    })

    it('実行中かどうか確かめられないときは、登録せずにエラーにする', async () => {
        const { client, rows, stats } = createFakeDb([], { failLookup: true })
        await expect(startStepExecutions(client, params(users(10)))).rejects.toThrow('実行中のステップ配信の確認に失敗')
        expect(stats.insertCalls).toBe(0)
        expect(rows).toHaveLength(0)
    })

    it('一意制約以外の登録エラーは失敗として数える', async () => {
        const { client } = createFakeDb([], { insertErrorCode: '57014' })
        const result = await startStepExecutions(client, params(users(3)))
        expect(result).toEqual({ created: 0, skipped: 0, failed: 3 })
    })

    it('対象がいなければ何もしない', async () => {
        const { client, stats } = createFakeDb([])
        expect(await startStepExecutions(client, params([]))).toEqual({ created: 0, skipped: 0, failed: 0 })
        expect(stats.insertCalls).toBe(0)
    })
})
