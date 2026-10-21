import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import { isChannelMember } from '@/lib/auth/channel-access'
import { calculateNextSendAt, chunk } from '@/lib/utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { startStepExecutions, USER_ID_LOOKUP_CHUNK } from '@/lib/step/start'

// 友だちが多いときも、対象の確認と登録を最後まで終えられるようにする
export const maxDuration = 60

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

        if (!scenario || !(await isChannelMember(user.id, scenario.channel_id))) {
            return NextResponse.json({ error: 'シナリオが見つかりません' }, { status: 404 })
        }

        // ステップメッセージを時間の早い順にソート
        const stepMessages = (scenario.step_messages || []).sort((a: any, b: any) => {
            if (a.delay_minutes !== b.delay_minutes) return a.delay_minutes - b.delay_minutes;
            const aHour = a.send_hour ?? 0;
            const bHour = b.send_hour ?? 0;
            if (aHour !== bHour) return aHour - bHour;
            return (a.send_minute ?? 0) - (b.send_minute ?? 0);
        });

        // 開始ステップのメッセージを取得（フロントからの startStep はソート後インデックス + 1）
        const startStepMessage = stepMessages[startStep - 1]
        if (!startStepMessage) {
            return NextResponse.json({ error: `ステップ ${startStep} が見つかりません` }, { status: 400 })
        }

        // 対象ユーザーを取得
        let targetUserIds: string[] = []

        if (targetType === 'users') {
            if (!userIds || userIds.length === 0) {
                return NextResponse.json({ error: 'ユーザーIDが必要です' }, { status: 400 })
            }
            // 他のチャンネルの友だちが混ざらないよう、シナリオと同じチャンネルの友だちだけに絞る
            // （一度に全員の id を IN 句に載せると URL 長の上限に当たって失敗するため、分けて引く）
            for (const ids of chunk([...new Set(userIds as string[])], USER_ID_LOOKUP_CHUNK)) {
                const { data: channelUsers, error: channelUsersError } = await adminSupabase
                    .from('line_users')
                    .select('id')
                    .eq('channel_id', scenario.channel_id)
                    .in('id', ids)
                if (channelUsersError) {
                    console.error('ステップ配信の対象の確認エラー:', channelUsersError)
                    return NextResponse.json({ error: '対象の友だちの確認に失敗しました' }, { status: 500 })
                }
                targetUserIds.push(...(channelUsers ?? []).map(u => u.id))
            }
        } else if (targetType === 'tag') {
            if (!tagId) {
                return NextResponse.json({ error: 'タグIDが必要です' }, { status: 400 })
            }
            const { data: tag } = await adminSupabase
                .from('tags')
                .select('id')
                .eq('id', tagId)
                .eq('channel_id', scenario.channel_id)
                .maybeSingle()
            if (!tag) {
                return NextResponse.json({ error: 'タグが見つかりません' }, { status: 404 })
            }
            // タグに紐づくユーザーを取得（1000行上限に当たらないようページングして全件取得する）
            const { data: tagUsers, error: tagUsersError } = await fetchAllRows<{ line_user_id: string }>((from, to) =>
                adminSupabase
                    .from('line_user_tags')
                    .select('line_user_id')
                    .eq('tag_id', tagId)
                    .order('id', { ascending: true })
                    .range(from, to)
            )
            if (tagUsersError) {
                console.error('ステップ配信の対象の取得エラー:', tagUsersError)
                return NextResponse.json({ error: 'タグの友だちの取得に失敗しました' }, { status: 500 })
            }

            if (tagUsers.length === 0) {
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

        // 新規にステップ実行を作成（実行中・実行済みの人はスキップ）
        const result = await startStepExecutions(adminSupabase, {
            scenarioId,
            lineUserIds: targetUserIds,
            currentStep: startStepMessage.step_order, // 実際の step_order を保存
            nextSendAt,
        })

        const notes = [`${result.skipped}人は既に実行中・実行済みのためスキップ`]
        if (result.failed > 0) notes.push(`${result.failed}人は登録に失敗しました。時間をおいてもう一度お試しください`)

        return NextResponse.json({
            success: true,
            created: result.created,
            skipped: result.skipped,
            failed: result.failed,
            message: `${result.created}人のステップ配信を開始しました（${notes.join('。')}）`,
        })
    } catch (error) {
        console.error('ステップ配信開始エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
