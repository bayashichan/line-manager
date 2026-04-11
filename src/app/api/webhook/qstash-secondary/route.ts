import { NextResponse } from 'next/server'
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { calculateNextSendAt } from '@/lib/utils'

/**
 * QStash経由で実行される副次処理
 * POST /api/webhook/qstash-secondary
 *
 * リッチメニュー適用・タグ付け・ステップ配信を確実に実行する
 */
async function handler(request: Request) {
    try {
        const { channelId, lineUserId, internalUserId } = await request.json()

        if (!channelId || !lineUserId || !internalUserId) {
            return NextResponse.json({ error: 'パラメータ不足' }, { status: 400 })
        }

        const supabase = createAdminClient()

        // チャネル情報を取得
        const { data: channel, error: channelError } = await supabase
            .from('channels')
            .select('*')
            .eq('id', channelId)
            .single()

        if (channelError || !channel) {
            console.error('QStash副次処理: チャネルが見つかりません:', channelId)
            return NextResponse.json({ error: 'チャネルが見つかりません' }, { status: 404 })
        }

        const lineClient = new LineClient(channel.channel_access_token)

        // デフォルトリッチメニューを適用
        if (channel.default_rich_menu_id) {
            try {
                const { data: richMenu } = await supabase
                    .from('rich_menus')
                    .select('rich_menu_id')
                    .eq('id', channel.default_rich_menu_id)
                    .single()

                if (richMenu?.rich_menu_id) {
                    await lineClient.linkRichMenuToUser(lineUserId, richMenu.rich_menu_id)
                }
                console.log(`QStash: リッチメニュー適用完了 (userId: ${lineUserId})`)
            } catch (err) {
                console.error(`QStash: リッチメニュー適用エラー (userId: ${lineUserId}):`, err)
            }
        }

        // 自動タグ付け処理
        if (channel.auto_reply_tags && channel.auto_reply_tags.length > 0) {
            try {
                const tagInserts = channel.auto_reply_tags.map((tagId: string) => ({
                    line_user_id: internalUserId,
                    tag_id: tagId,
                }))

                const { error: tagError } = await supabase
                    .from('line_user_tags')
                    .insert(tagInserts)

                if (tagError) {
                    console.error(`QStash: 自動タグ付けエラー (userId: ${lineUserId}):`, tagError)
                } else {
                    console.log(`QStash: 自動タグ付け完了: ${tagInserts.length} 件 (userId: ${lineUserId})`)

                    const { recalculateAndSwitchUserRichMenu } = await import('@/lib/rich-menu')
                    await recalculateAndSwitchUserRichMenu(internalUserId)
                }
            } catch (err) {
                console.error(`QStash: タグ処理エラー (userId: ${lineUserId}):`, err)
            }
        }

        // フォロートリガーのステップ配信を開始
        try {
            // フォロートリガーのアクティブなシナリオを取得
            const { data: scenarios } = await supabase
                .from('step_scenarios')
                .select(`
                    id,
                    step_messages(
                        delay_minutes,
                        send_hour,
                        send_minute
                    )
                `)
                .eq('channel_id', channelId)
                .eq('trigger_type', 'follow')
                .eq('is_active', true)
                .order('step_messages(step_order)', { ascending: true })

            if (scenarios && scenarios.length > 0) {
                for (const scenario of scenarios) {
                    const firstMessage = scenario.step_messages?.[0]
                    const delayMinutes = firstMessage?.delay_minutes || 0
                    const sendHour = firstMessage?.send_hour ?? null
                    const sendMinute = firstMessage?.send_minute ?? 0
                    const nextSendAt = calculateNextSendAt(new Date(), delayMinutes, sendHour, sendMinute)

                    await supabase.from('step_executions').insert({
                        scenario_id: scenario.id,
                        line_user_id: internalUserId,
                        current_step: 1,
                        next_send_at: nextSendAt,
                    })
                }
                console.log(`QStash: ステップ配信開始完了 (userId: ${lineUserId})`)
            }
        } catch (err) {
            console.error(`QStash: ステップ配信開始エラー (userId: ${lineUserId}):`, err)
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('QStash副次処理エラー:', error)
        return NextResponse.json({ error: '内部エラー' }, { status: 500 })
    }
}

export const POST = verifySignatureAppRouter(handler)
