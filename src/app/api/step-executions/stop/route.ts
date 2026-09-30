import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import { isChannelMember } from '@/lib/auth/channel-access'

/**
 * ステップ配信を手動で停止するAPI
 * POST /api/step-executions/stop
 *
 * Body:
 * - executionId: string (実行ID)
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
        const { executionId } = body

        if (!executionId) {
            return NextResponse.json({ error: '実行IDが必要です' }, { status: 400 })
        }

        const adminSupabase = createAdminClient()

        // 実行中のシナリオのチャンネルのメンバーだけが停止できる
        const { data: execution } = await adminSupabase
            .from('step_executions')
            .select('id, step_scenarios(channel_id)')
            .eq('id', executionId)
            .maybeSingle()
        const scenario = Array.isArray(execution?.step_scenarios) ? execution?.step_scenarios[0] : execution?.step_scenarios
        if (!execution || !(await isChannelMember(user.id, scenario?.channel_id))) {
            return NextResponse.json({ error: '配信が見つかりません' }, { status: 404 })
        }

        // ステータスをcancelledに更新
        const { error } = await adminSupabase
            .from('step_executions')
            .update({ status: 'cancelled' })
            .eq('id', executionId)

        if (error) {
            throw error
        }

        return NextResponse.json({
            success: true,
            message: 'ステップ配信を停止しました',
        })
    } catch (error) {
        console.error('ステップ配信停止エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
