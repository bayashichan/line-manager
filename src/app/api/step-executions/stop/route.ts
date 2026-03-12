import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'

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
