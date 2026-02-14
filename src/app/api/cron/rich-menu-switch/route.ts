import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'

/**
 * リッチメニュー表示期間に基づく自動切替Cronジョブ
 * GET /api/cron/rich-menu-switch
 * 
 * 毎時実行され、以下を行う:
 * 1. 表示期間が「今」開始されたリッチメニューをデフォルトに適用
 * 2. 表示期間が「今」終了したリッチメニューを元のデフォルトに戻す
 */
export async function GET(request: NextRequest) {
    // Cron認証
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: '認証エラー' }, { status: 401 })
    }

    const supabase = createAdminClient()
    const now = new Date().toISOString()
    const results: { channelId: string; action: string; menuName: string }[] = []

    try {
        // 全チャンネルを取得
        const { data: channels, error: channelError } = await supabase
            .from('channels')
            .select('id, channel_access_token, default_rich_menu_id')

        if (channelError || !channels) {
            console.error('チャンネル取得エラー:', channelError)
            return NextResponse.json({ error: 'チャンネル取得失敗' }, { status: 500 })
        }

        for (const channel of channels) {
            if (!channel.channel_access_token) continue

            const lineClient = new LineClient(channel.channel_access_token)

            // 現在時刻が表示期間内のリッチメニューを優先度で取得
            // （期間が設定されていて、今がその範囲内のもの）
            const { data: activeMenus } = await supabase
                .from('rich_menus')
                .select('*')
                .eq('channel_id', channel.id)
                .not('display_period_start', 'is', null)
                .not('display_period_end', 'is', null)
                .lte('display_period_start', now)
                .gte('display_period_end', now)
                .not('rich_menu_id', 'is', null) // LINE APIに登録済みのみ
                .order('created_at', { ascending: false })
                .limit(1)

            if (activeMenus && activeMenus.length > 0) {
                const activeMenu = activeMenus[0]

                // この期間メニューが既にデフォルトとして設定されているか確認
                // is_active フラグで管理（重複適用を防止）
                if (!activeMenu.is_active) {
                    try {
                        // デフォルトリッチメニューとして適用
                        await lineClient.setDefaultRichMenu(activeMenu.rich_menu_id!)

                        // DBフラグ更新
                        await supabase
                            .from('rich_menus')
                            .update({ is_active: true })
                            .eq('id', activeMenu.id)

                        results.push({
                            channelId: channel.id,
                            action: 'activated',
                            menuName: activeMenu.name,
                        })

                        console.log(`期間メニュー適用: ${activeMenu.name} (チャンネル: ${channel.id})`)
                    } catch (err) {
                        console.error(`期間メニュー適用エラー: ${activeMenu.name}`, err)
                    }
                }
            } else {
                // 期間内のメニューがない → 期間が終了したアクティブメニューを元に戻す
                const { data: expiredMenus } = await supabase
                    .from('rich_menus')
                    .select('*')
                    .eq('channel_id', channel.id)
                    .eq('is_active', true)
                    .not('display_period_end', 'is', null)
                    .lt('display_period_end', now)

                for (const expiredMenu of expiredMenus || []) {
                    try {
                        // is_active を解除
                        await supabase
                            .from('rich_menus')
                            .update({ is_active: false })
                            .eq('id', expiredMenu.id)

                        // デフォルトメニューに戻す
                        const { data: defaultMenu } = await supabase
                            .from('rich_menus')
                            .select('rich_menu_id, name')
                            .eq('channel_id', channel.id)
                            .eq('is_default', true)
                            .not('rich_menu_id', 'is', null)
                            .single()

                        if (defaultMenu?.rich_menu_id) {
                            await lineClient.setDefaultRichMenu(defaultMenu.rich_menu_id)
                            results.push({
                                channelId: channel.id,
                                action: 'reverted_to_default',
                                menuName: defaultMenu.name,
                            })
                            console.log(`デフォルトメニューに復帰: ${defaultMenu.name}`)
                        }
                    } catch (err) {
                        console.error(`期間メニュー解除エラー: ${expiredMenu.name}`, err)
                    }
                }
            }
        }

        return NextResponse.json({
            success: true,
            processedAt: now,
            results,
        })
    } catch (error) {
        console.error('リッチメニュー切替Cronエラー:', error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
