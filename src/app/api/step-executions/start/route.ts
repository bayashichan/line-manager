import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import { calculateNextSendAt } from '@/lib/utils'

/**
 * ステップ配信を手動で開始するAPI
 * POST /api/step-executions/start
 *
 * Body:
 * - scenarioId: string (シナリオID)
 * - startStep: number (開始ステップ番号, 1始まり)
 * - targetType: 'users' | 'tag' (対象の種別)
 * - userIds?: string[] (targetType='users'の場合、line_usersテーブルのid)
 * - tagId?: string (targetType='tag'の場合、タグID)
 */
export async function POST(request: NextRequest) {
    try {
        // 認証チェック
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証エラー' }, { status: 401 })
        }

        const body = await request.json()
        const { scenarioId, startStep = 1, targetType, userIds, tagId } = body

        if (!scenarioId) {
            return NextResponse.json({ error: 'シナリオIDが必要です' }, { status: 400 })
        }

        if (targetType !== 'users' && targetType !== 'tag') {
            return NextResponse.json({ error: '対象の種別（users/tag）が必要です' }, { status: 400 })
        }

        const adminSupabase = createAdminClient()

        // シナリオとステップメッセージを取得
        const { data: scenario } = await adminSupabase
            .from('step_scenarios')
            .select('*, step_messages(*)')
            .eq('id', scenarioId)
            .single()

        if (!scenario) {
            return NextResponse.json({ error: 'シナリオが見つかりません' }, { status: 404 })
        }

        // ステップメッセージをソート
        const stepMessages = (scenario.step_messages || []).sort(
            (a: any, b: any) => a.step_order - b.step_order
        )

        // 開始ステップのメッセージを取得
        const startStepMessage = stepMessages.find((sm: any) => sm.step_order === startStep)
        if (!startStepMessage) {
            return NextResponse.json({ error: `ステップ ${startStep} が見つかりません` }, { status: 400 })
        }

        // 対象ユーザーを取得
        let targetUserIds: string[] = []

        if (targetType === 'users') {
            if (!userIds || userIds.length === 0) {
                return NextResponse.json({ error: 'ユーザーIDが必要です' }, { status: 400 })
            }
            targetUserIds = userIds
        } else if (targetType === 'tag') {
            if (!tagId) {
                return NextResponse.json({ error: 'タグIDが必要です' }, { status: 400 })
            }
            // タグに紐づくユーザーを取得
            const { data: tagUsers } = await adminSupabase
                .from('line_user_tags')
                .select('line_user_id')
                .eq('tag_id', tagId)

            if (!tagUsers || tagUsers.length === 0) {
                return NextResponse.json({ error: 'このタグのユーザーが見つかりません' }, { status: 400 })
            }
            targetUserIds = tagUsers.map(tu => tu.line_user_id)
        }

        // next_send_at を計算
        const now = new Date()
        const nextSendAt = calculateNextSendAt(
            now,
            startStepMessage.delay_minutes,
            startStepMessage.send_hour ?? null,
            startStepMessage.send_minute ?? 0
        )

        // 既存のアクティブな実行を取得（重複回避）
        const { data: existingExecutions } = await adminSupabase
            .from('step_executions')
            .select('line_user_id')
            .eq('scenario_id', scenarioId)
            .eq('status', 'active')
            .in('line_user_id', targetUserIds)

        const existingUserIds = new Set(existingExecutions?.map(e => e.line_user_id) || [])

        // 新規にステップ実行を作成（既存はスキップ）
        let createdCount = 0
        let skippedCount = 0

        for (const userId of targetUserIds) {
            if (existingUserIds.has(userId)) {
                skippedCount++
                continue
            }

            await adminSupabase.from('step_executions').insert({
                scenario_id: scenarioId,
                line_user_id: userId,
                current_step: startStep,
                next_send_at: nextSendAt,
                status: 'active',
            })
            createdCount++
        }

        return NextResponse.json({
            success: true,
            created: createdCount,
            skipped: skippedCount,
            message: `${createdCount}人のステップ配信を開始しました（${skippedCount}人は既に実行中のためスキップ）`,
        })
    } catch (error) {
        console.error('ステップ配信開始エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
