import type { SupabaseClient } from '@supabase/supabase-js'
import { chunk, runWithConcurrency } from '@/lib/utils'

/**
 * ステップ配信の実行（step_executions）をまとめて作る（手動開始・タグ付与トリガーで共通）。
 *
 * 友だちが多くても途中で止まらないよう、1人ずつではなくまとめて処理する。
 * - すでに実行中の人は除く（IN 句は URL 長の上限に当てないよう分割して引く）
 * - 500件ずつまとめて登録する
 * - 同じシナリオ・同じ人の実行は DB の一意制約で1つまで（supabase/schema.sql）。
 *   完了済みの人などで制約に当たったまとまりは1件ずつ登録し直し、当たった人は開始しない
 */

export type StartStepExecutionsResult = {
    created: number
    /** 同じシナリオの実行がすでにある（実行中・実行済み）ため開始しなかった人数 */
    skipped: number
    /** 登録に失敗した人数 */
    failed: number
}

// userId の IN 句で引くときの分割数（URL長の上限に当てないため）
export const USER_ID_LOOKUP_CHUNK = 100

const INSERT_CHUNK = 500
const UNIQUE_VIOLATION = '23505'

export async function startStepExecutions(
    supabase: SupabaseClient,
    params: { scenarioId: string; lineUserIds: string[]; currentStep: number; nextSendAt: string }
): Promise<StartStepExecutionsResult> {
    const { scenarioId, currentStep, nextSendAt } = params
    const userIds = [...new Set(params.lineUserIds)]
    const result: StartStepExecutionsResult = { created: 0, skipped: 0, failed: 0 }
    if (userIds.length === 0) return result

    const active = new Set<string>()
    for (const ids of chunk(userIds, USER_ID_LOOKUP_CHUNK)) {
        const { data, error } = await supabase
            .from('step_executions')
            .select('line_user_id')
            .eq('scenario_id', scenarioId)
            .eq('status', 'active')
            .in('line_user_id', ids)
        // 確かめられないまま登録すると、実行中の人にもう一度始めてしまうおそれがあるため止める
        if (error) throw new Error(`実行中のステップ配信の確認に失敗: ${error.message}`)
        for (const row of data ?? []) active.add(row.line_user_id)
    }

    const targets = userIds.filter(id => !active.has(id))
    result.skipped = userIds.length - targets.length

    const rowOf = (lineUserId: string) => ({
        scenario_id: scenarioId,
        line_user_id: lineUserId,
        current_step: currentStep,
        next_send_at: nextSendAt,
        status: 'active',
    })

    for (const ids of chunk(targets, INSERT_CHUNK)) {
        const { error } = await supabase.from('step_executions').insert(ids.map(rowOf))
        if (!error) {
            result.created += ids.length
            continue
        }
        if (error.code !== UNIQUE_VIOLATION) {
            console.error(`ステップ配信の登録エラー (scenarioId: ${scenarioId}):`, error)
            result.failed += ids.length
            continue
        }

        // 同じシナリオの実行がある人（完了済みなど）が含まれていた。1件ずつ登録し直す
        await runWithConcurrency(ids, 10, async lineUserId => {
            const { error: rowError } = await supabase.from('step_executions').insert(rowOf(lineUserId))
            if (!rowError) {
                result.created++
            } else if (rowError.code === UNIQUE_VIOLATION) {
                result.skipped++
            } else {
                console.error(`ステップ配信の登録エラー (scenarioId: ${scenarioId}, lineUserId: ${lineUserId}):`, rowError)
                result.failed++
            }
        })
    }

    return result
}
