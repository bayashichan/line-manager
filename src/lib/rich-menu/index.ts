import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { calculateNextSendAt } from '@/lib/utils'
import type { Tag, RichMenu } from '@/types'

/**
 * タグ付与時のリッチメニュー切り替え処理
 */
export async function processRichMenuSwitchOnTagAssign(
    lineUserId: string,
    tagId: string
): Promise<void> {
    const supabase = createAdminClient()

    // タグ情報を取得
    const { data: tag, error: tagError } = await supabase
        .from('tags')
        .select('*, rich_menus(*)')
        .eq('id', tagId)
        .single()

    if (tagError || !tag) {
        console.error('タグ取得エラー:', tagError)
        return
    }

    // ユーザー情報を取得
    const { data: lineUser, error: userError } = await supabase
        .from('line_users')
        .select('*, channels(*)')
        .eq('id', lineUserId)
        .single()

    if (userError || !lineUser) {
        console.error('ユーザー取得エラー:', userError)
        return
    }

    // 新しいリッチメニューを判定
    const newRichMenuId = await determineRichMenuForUser(supabase, lineUserId)

    // 変更が必要な場合のみAPI呼び出し
    if (newRichMenuId !== lineUser.current_rich_menu_id) {
        await switchRichMenu(supabase, lineUser, newRichMenuId)
    }

    // タグ付与トリガーのステップ配信を開始
    await startTagStepScenarios(supabase, lineUserId, tagId)
}

/**
 * タグ解除時のリッチメニュー切り替え処理
 */
export async function processRichMenuSwitchOnTagRemove(
    lineUserId: string
): Promise<void> {
    const supabase = createAdminClient()

    // ユーザー情報を取得
    const { data: lineUser, error: userError } = await supabase
        .from('line_users')
        .select('*, channels(*)')
        .eq('id', lineUserId)
        .single()

    if (userError || !lineUser) {
        console.error('ユーザー取得エラー:', userError)
        return
    }

    // 新しいリッチメニューを判定
    const newRichMenuId = await determineRichMenuForUser(supabase, lineUserId)

    // 変更が必要な場合のみAPI呼び出し
    if (newRichMenuId !== lineUser.current_rich_menu_id) {
        await switchRichMenu(supabase, lineUser, newRichMenuId)
    }
}

/**
 * ユーザーに適用すべきリッチメニューを判定
 * 優先順位: 表示期間内メニュー > タグ連動メニュー > デフォルトメニュー
 */
async function determineRichMenuForUser(
    supabase: ReturnType<typeof createAdminClient>,
    lineUserId: string
): Promise<string | null> {
    // ユーザーのチャンネルIDを取得
    const { data: lineUser } = await supabase
        .from('line_users')
        .select('channel_id, channels(default_rich_menu_id)')
        .eq('id', lineUserId)
        .single()

    if (!lineUser) return null

    const now = new Date().toISOString()

    // 1. 表示期間内のリッチメニューを優先チェック
    const { data: periodMenus } = await supabase
        .from('rich_menus')
        .select('id')
        .eq('channel_id', lineUser.channel_id)
        .not('display_period_start', 'is', null)
        .not('display_period_end', 'is', null)
        .lte('display_period_start', now)
        .gte('display_period_end', now)
        .not('rich_menu_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)

    if (periodMenus && periodMenus.length > 0) {
        return periodMenus[0].id
    }

    // 2. ユーザーの全タグを優先度順で取得（タグ連動メニュー）
    const { data: userTags, error } = await supabase
        .from('line_user_tags')
        .select(`
      tags (
        id,
        linked_rich_menu_id,
        priority
      )
    `)
        .eq('line_user_id', lineUserId)
        .order('tags(priority)', { ascending: false })

    if (error) {
        console.error('ユーザータグ取得エラー:', error)
        return null
    }

    // 優先度順にリッチメニュー連動タグを探す
    for (const userTag of userTags || []) {
        const tag = userTag.tags as unknown as Tag
        if (tag?.linked_rich_menu_id) {
            return tag.linked_rich_menu_id
        }
    }

    // 3. なければデフォルトリッチメニューを返す
    return (lineUser?.channels as any)?.default_rich_menu_id || null
}

/**
 * リッチメニューを切り替え
 */
async function switchRichMenu(
    supabase: ReturnType<typeof createAdminClient>,
    lineUser: { id: string; line_user_id: string; channels: any },
    newRichMenuId: string | null
): Promise<void> {
    const lineClient = new LineClient(lineUser.channels.channel_access_token)

    try {
        if (newRichMenuId) {
            // 新しいリッチメニューのLINE IDを取得
            const { data: richMenu } = await supabase
                .from('rich_menus')
                .select('rich_menu_id')
                .eq('id', newRichMenuId)
                .single()

            if (richMenu?.rich_menu_id) {
                await lineClient.linkRichMenuToUser(
                    lineUser.line_user_id,
                    richMenu.rich_menu_id
                )
            }
        } else {
            // リッチメニューをアンリンク
            await lineClient.unlinkRichMenuFromUser(lineUser.line_user_id)
        }

        // DBを更新
        await supabase
            .from('line_users')
            .update({ current_rich_menu_id: newRichMenuId })
            .eq('id', lineUser.id)

        console.log(
            `リッチメニュー切り替え: ${lineUser.line_user_id} -> ${newRichMenuId}`
        )
    } catch (error) {
        console.error('リッチメニュー切り替えエラー:', error)
        throw error
    }
}

/**
 * タグ付与トリガーのステップ配信を開始
 */
async function startTagStepScenarios(
    supabase: ReturnType<typeof createAdminClient>,
    lineUserId: string,
    tagId: string
): Promise<void> {
    // このタグをトリガーとするシナリオを取得
    const { data: scenarios } = await supabase
        .from('step_scenarios')
        .select(`
      id,
      step_messages (
        delay_minutes,
        send_hour,
        send_minute
      )
    `)
        .eq('trigger_type', 'tag_assigned')
        .eq('trigger_tag_id', tagId)
        .eq('is_active', true)
        .order('step_messages(step_order)', { ascending: true })

    if (!scenarios || scenarios.length === 0) return

    for (const scenario of scenarios) {
        // 既に実行中でないか確認
        const { data: existing } = await supabase
            .from('step_executions')
            .select('id')
            .eq('scenario_id', scenario.id)
            .eq('line_user_id', lineUserId)
            .eq('status', 'active')
            .single()

        if (existing) continue

        const firstMessage = scenario.step_messages?.[0]
        const delayMinutes = firstMessage?.delay_minutes || 0
        const sendHour = firstMessage?.send_hour ?? null
        const sendMinute = firstMessage?.send_minute ?? 0
        const nextSendAt = calculateNextSendAt(new Date(), delayMinutes, sendHour, sendMinute)

        await supabase.from('step_executions').insert({
            scenario_id: scenario.id,
            line_user_id: lineUserId,
            current_step: 1,
            next_send_at: nextSendAt,
        })
    }
}
