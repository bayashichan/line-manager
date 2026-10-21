import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { calculateNextSendAt } from '@/lib/utils'
import { startStepExecutions } from '@/lib/step/start'
import { pickTagMenuId, type TagMenuCandidate } from './plan'
import { syncChannelRichMenus } from './sync'

export { syncChannelRichMenus, syncScheduledRichMenus, saveRichMenuRules } from './sync'
export type { RichMenuSyncOptions, RichMenuSyncResult, RichMenuRuleChanges } from './sync'

/*
 * リッチメニューの出し分けの考え方
 *
 * LINE の表示の優先順位は「ユーザー個別のリンク ＞ デフォルトリッチメニュー」。
 * - 全員向け（基本のメニュー / 表示期間中のメニュー）は LINE のデフォルトとして設定し、
 *   ユーザーには個別リンクを付けない。付けてしまうと、あとでデフォルトを変えても
 *   その人には古いメニューが出続ける
 * - タグ連動メニューだけを、そのタグの人に個別リンクする
 *
 * line_users.current_rich_menu_id は「個別リンク中のメニュー」（null = 全員向けに従っている）。
 */

/**
 * タグ付与時のリッチメニュー切り替え処理
 */
export async function processRichMenuSwitchOnTagAssign(
    lineUserId: string,
    tagId: string
): Promise<void> {
    const supabase = createAdminClient()

    await recalculateAndSwitchUserRichMenu(lineUserId)

    // タグ付与トリガーのステップ配信を開始
    await startTagStepScenarios(supabase, [lineUserId], tagId)
}

/**
 * 複数の友だちにまとめてタグを付けたあとの処理（友だち一覧の一括タグ付与）。
 *
 * 1人ずつ processRichMenuSwitchOnTagAssign を呼ぶと人数に比例して時間がかかり、
 * 友だちが多いと途中で時間切れになって、後半の人にメニュー切り替えやステップ配信が届かないため、まとめて行う。
 * - リッチメニュー: タグ連動メニューのあるタグを付けたときだけ、そのチャンネルを一括で揃え直す
 *   （「LINEと揃え直す」と同じ処理。メニューのないタグを付けても表示は変わらない）
 * - ステップ配信: タグ付与トリガーのシナリオを、まだ実行中でない人にまとめて開始する
 */
export async function processBulkTagAssign(
    lineUserIds: string[],
    tagIds: string[]
): Promise<void> {
    const supabase = createAdminClient()

    const { data: tags, error } = await supabase
        .from('tags')
        .select('id, channel_id, linked_rich_menu_id')
        .in('id', tagIds)

    if (error) {
        console.error('一括タグ付与後の処理: タグの取得エラー:', error)
        return
    }

    const channelIds = new Set(
        (tags ?? []).filter(t => t.linked_rich_menu_id).map(t => t.channel_id as string)
    )
    for (const channelId of channelIds) {
        try {
            const result = await syncChannelRichMenus(channelId)
            if (result.warnings.length > 0) {
                console.warn(`一括タグ付与後のリッチメニュー反映 (channelId: ${channelId}):`, result.warnings)
            }
        } catch (err) {
            console.error(`一括タグ付与後のリッチメニュー反映エラー (channelId: ${channelId}):`, err)
        }
    }

    for (const tagId of tagIds) {
        await startTagStepScenarios(supabase, lineUserIds, tagId)
    }
}

/**
 * タグ解除時のリッチメニュー切り替え処理
 */
export async function processRichMenuSwitchOnTagRemove(
    lineUserId: string
): Promise<void> {
    await recalculateAndSwitchUserRichMenu(lineUserId)
}

/**
 * ユーザーのリッチメニューを再計算して切り替え
 *
 * タグ連動メニューがあればその人に個別リンクし、なければ個別リンクを外して
 * 全員向け（LINE のデフォルト）に従わせる。
 *
 * @param options.force DB上の「現在のメニュー」と同じでも LINE に送り直す。
 *   友だち追加（ブロック解除）時は LINE 側の表示と DB の記録がずれていることがあるため使う。
 */
export async function recalculateAndSwitchUserRichMenu(
    lineUserId: string,
    options: { force?: boolean } = {}
): Promise<void> {
    const supabase = createAdminClient()

    // ユーザー情報を取得
    const { data: lineUser, error: userError } = await supabase
        .from('line_users')
        .select('id, line_user_id, current_rich_menu_id, channels(channel_access_token)')
        .eq('id', lineUserId)
        .single()

    if (userError || !lineUser) {
        console.error('ユーザー取得エラー:', userError)
        return
    }

    const target = await determineTagRichMenuForUser(supabase, lineUserId)
    const targetMenuId = target?.menuId ?? null

    // 変更が必要な場合のみAPI呼び出し（強制時は同じでも送り直す）
    if (!options.force && targetMenuId === lineUser.current_rich_menu_id) return

    const channel = lineUser.channels as unknown as { channel_access_token: string } | null
    if (!channel?.channel_access_token) return

    const lineClient = new LineClient(channel.channel_access_token)

    try {
        if (target) {
            await lineClient.linkRichMenuToUser(lineUser.line_user_id, target.lineRichMenuId)
        } else {
            await lineClient.unlinkRichMenuFromUser(lineUser.line_user_id)
        }

        await supabase
            .from('line_users')
            .update({ current_rich_menu_id: targetMenuId })
            .eq('id', lineUser.id)

        console.log(
            `リッチメニュー切り替え: ${lineUser.line_user_id} -> ${targetMenuId ?? '全員向け（デフォルト）'}`
        )
    } catch (error) {
        console.error('リッチメニュー切り替えエラー:', error)
        throw error
    }
}

/**
 * ユーザーに個別リンクすべきタグ連動メニューを判定する（なければ null = 全員向けに従う）。
 * LINE に未反映のメニューは付けられないので候補から外す。
 */
async function determineTagRichMenuForUser(
    supabase: ReturnType<typeof createAdminClient>,
    lineUserId: string
): Promise<{ menuId: string; lineRichMenuId: string } | null> {
    const { data: userTags, error } = await supabase
        .from('line_user_tags')
        .select(`
      tags (
        id,
        linked_rich_menu_id,
        priority,
        rich_menus ( id, rich_menu_id )
      )
    `)
        .eq('line_user_id', lineUserId)

    if (error) {
        console.error('ユーザータグ取得エラー:', error)
        return null
    }

    type TagWithMenu = {
        id: string
        linked_rich_menu_id: string | null
        priority: number | null
        rich_menus: { id: string; rich_menu_id: string | null } | null
    }

    const tags = (userTags || [])
        .map(ut => ut.tags as unknown as TagWithMenu | null)
        .filter((t): t is TagWithMenu => Boolean(t?.linked_rich_menu_id))

    const lineIdByMenu = new Map<string, string>()
    for (const tag of tags) {
        if (tag.rich_menus?.rich_menu_id) lineIdByMenu.set(tag.rich_menus.id, tag.rich_menus.rich_menu_id)
    }

    const candidates: TagMenuCandidate[] = tags.map(t => ({
        tagId: t.id,
        linkedMenuId: t.linked_rich_menu_id,
        priority: t.priority,
    }))

    const menuId = pickTagMenuId(candidates, new Set(lineIdByMenu.keys()))
    return menuId ? { menuId, lineRichMenuId: lineIdByMenu.get(menuId)! } : null
}

/**
 * タグ付与トリガーのステップ配信を開始（まだ実行中でない人だけ）
 */
async function startTagStepScenarios(
    supabase: ReturnType<typeof createAdminClient>,
    lineUserIds: string[],
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
        const firstMessage = scenario.step_messages?.[0]
        const delayMinutes = firstMessage?.delay_minutes || 0
        const sendHour = firstMessage?.send_hour ?? null
        const sendMinute = firstMessage?.send_minute ?? 0
        const nextSendAt = calculateNextSendAt(new Date(), delayMinutes, sendHour, sendMinute)

        // 失敗してもタグの付与自体は済んでいるので、ほかのシナリオは続ける
        try {
            await startStepExecutions(supabase, {
                scenarioId: scenario.id,
                lineUserIds,
                currentStep: 1,
                nextSendAt,
            })
        } catch (err) {
            console.error(`タグ付与トリガーのステップ配信開始エラー (scenarioId: ${scenario.id}):`, err)
        }
    }
}
