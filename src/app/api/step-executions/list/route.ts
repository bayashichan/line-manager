import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { cookies } from 'next/headers'

export async function GET(request: Request) {
    try {
        const user = await getSessionUser()
        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const supabase = createAdminClient()
        const cookieStore = await cookies()
        const channelId = cookieStore.get('line-manager-channel-id')?.value

        if (!channelId) {
            return NextResponse.json({ error: 'チャンネルが選択されていません' }, { status: 400 })
        }

        // Cookie のチャンネルIDは書き換えられるため、メンバーであることを確認する
        if (!(await isChannelMember(user.id, channelId))) {
            return NextResponse.json({ error: 'このチャンネルを表示する権限がありません' }, { status: 403 })
        }

        // URLからパラメータ取得
        const { searchParams } = new URL(request.url)
        const status = searchParams.get('status')
        const scenarioId = searchParams.get('scenarioId')

        // 配信状況を取得（1000行上限で切れると件数の集計も少なく出るため、ページングして全件取得する）
        const buildQuery = (from: number, to: number) => {
            let query = supabase
                .from('step_executions')
                .select(`
                    id,
                    current_step,
                    status,
                    next_send_at,
                    started_at,
                    completed_at,
                    step_scenarios!inner (
                        id,
                        name,
                        channel_id
                    ),
                    line_users!inner (
                        id,
                        display_name,
                        picture_url,
                        line_user_id
                    )
                `)
                .eq('step_scenarios.channel_id', channelId)

            if (status) {
                query = query.eq('status', status)
            }
            if (scenarioId && scenarioId !== 'all') {
                query = query.eq('scenario_id', scenarioId)
            }

            return query
                .order('started_at', { ascending: false })
                .order('id', { ascending: true })
                .range(from, to)
        }

        const { data: executions, error } = await fetchAllRows(buildQuery)

        if (error) {
            console.error('配信状況取得エラー:', error)
            return NextResponse.json({ error: '配信状況の取得に失敗しました' }, { status: 500 })
        }

        return NextResponse.json({ executions })
    } catch (error) {
        console.error('予期せぬエラー:', error)
        return NextResponse.json({ error: 'サーバーエラーが発生しました' }, { status: 500 })
    }
}
