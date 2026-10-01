import { createAdminClient } from '@/lib/supabase/server'
import { LineApiError, LineClient } from '@/lib/line'
import type { RichMenuArea } from '@/types'
import { createLineRichMenu } from './publish'
import {
    chunk,
    hasUpcomingDisplayPeriod,
    pickAllUsersMenu,
    pickTagMenuId,
    planRichMenuLinks,
    type TagMenuCandidate,
    type UserMenuState,
} from './plan'

type AdminClient = ReturnType<typeof createAdminClient>

const MENU_COLUMNS =
    'id, channel_id, name, rich_menu_id, image_url, areas, is_default, display_period_start, display_period_end, created_at'

type MenuRow = {
    id: string
    channel_id: string
    name: string
    rich_menu_id: string | null
    image_url: string | null
    areas: RichMenuArea[] | null
    is_default: boolean | null
    display_period_start: string | null
    display_period_end: string | null
    created_at: string
}

/** LINE の一括リンク / 一括アンリンクで一度に送れる人数 */
const BULK_LIMIT = 500

export type RichMenuSyncOptions = {
    /**
     * DB の記録に関係なく、全員の個別設定を LINE に送り直す。
     * 過去に記録なしで付けたリンクなど、LINE 側の表示と DB がずれていても揃う。
     */
    force?: boolean
    /** 内容（画像・タップ領域）を編集したメニュー。LINE に反映済み、または使用中なら作り直す */
    editedMenuIds?: string[]
    /** 使っていなくても LINE に（作り直して）反映するメニュー */
    publishMenuIds?: string[]
}

export type RichMenuSyncResult = {
    /** 全員向けに表示しているメニュー（LINE のデフォルトに設定したもの） */
    allUsersMenu: { id: string; name: string; reason: 'period' | 'default' } | null
    /** タグ連動メニューを個別に付けた人数 */
    linked: number
    /** 個別設定を外して全員向けに戻した人数 */
    unlinked: number
    /** LINE への送信に失敗した人数 */
    failed: number
    /** LINE に新しく反映（作り直し）したメニュー */
    published: { id: string; name: string; skippedAreaNumbers: number[] }[]
    /** LINE に反映できなかったメニュー（画像の条件違反など） */
    failedMenus: { id: string; name: string; message: string }[]
    warnings: string[]
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** LINE が混んでいる（429）・一時的な障害（5xx）のときだけ、少し待ってやり直す */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
    const delays = [1000, 3000]
    for (let attempt = 0; ; attempt++) {
        try {
            return await run()
        } catch (err) {
            const retryable = err instanceof LineApiError && (err.status === 429 || err.status >= 500)
            if (!retryable || attempt >= delays.length) throw err
            await sleep(delays[attempt])
        }
    }
}

/** 同時実行数を絞って順に処理する */
async function runWithConcurrency<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
    let next = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next++]
            await run(item)
        }
    })
    await Promise.all(workers)
}

/** Supabase の1回あたりの上限（1000行）を超えて全件取得する */
async function fetchAllRows<T>(
    fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
    const PAGE = 1000
    const rows: T[] = []
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await fetchPage(from, from + PAGE - 1)
        if (error) throw error
        rows.push(...(data ?? []))
        if (!data || data.length < PAGE) break
    }
    return rows
}

/**
 * LINE 上にメニューを作り（作り直し）、DB に新しい LINE のIDを記録する。
 * 同時に別の処理が作り直していた場合はこちらで作った分を消し、null を返す。
 */
async function publishMenu(
    supabase: AdminClient,
    lineClient: LineClient,
    menu: MenuRow
): Promise<{ lineRichMenuId: string; skippedAreaNumbers: number[] } | null> {
    const { lineRichMenuId, skippedAreaNumbers } = await createLineRichMenu(lineClient, menu)

    let update = supabase
        .from('rich_menus')
        .update({ rich_menu_id: lineRichMenuId })
        .eq('id', menu.id)
    update = menu.rich_menu_id
        ? update.eq('rich_menu_id', menu.rich_menu_id)
        : update.is('rich_menu_id', null)

    const { data: updated, error } = await update.select('id')

    if (error || !updated || updated.length === 0) {
        await lineClient.deleteRichMenu(lineRichMenuId).catch(() => { })
        if (error) throw error
        return null
    }

    return { lineRichMenuId, skippedAreaNumbers }
}

/** LINE が見つけられない（消された）メニューかどうか。判定できないときは「ある」とみなす */
async function isMissingOnLine(lineClient: LineClient, lineRichMenuId: string): Promise<boolean> {
    try {
        return !(await lineClient.richMenuExists(lineRichMenuId))
    } catch {
        return false
    }
}

/**
 * まとめて LINE に送り、成功した人を返す。
 * 一部のユーザーIDが原因で一括APIが断られた（400）ときだけ、1人ずつ送り直す。
 * トークン不正などほかの理由のときは、1人ずつ送っても同じなので送り直さない。
 */
async function sendInBulk(
    users: UserMenuState[],
    bulk: (lineUserIds: string[]) => Promise<void>,
    single: (lineUserId: string) => Promise<void>
): Promise<UserMenuState[]> {
    try {
        await withRetry(() => bulk(users.map(u => u.lineUserId)))
        return users
    } catch (err) {
        if (!(err instanceof LineApiError && err.status === 400)) {
            console.error('リッチメニュー一括送信エラー:', err)
            return []
        }
        console.error('リッチメニュー一括送信エラー（1人ずつ送り直します）:', err)
    }

    const succeeded: UserMenuState[] = []
    await runWithConcurrency(users, 5, async user => {
        try {
            await withRetry(() => single(user.lineUserId))
            succeeded.push(user)
        } catch (err) {
            console.error(`リッチメニュー送信エラー (userId: ${user.lineUserId}):`, err)
        }
    })
    return succeeded
}

/** 個別リンク中のメニューを DB に記録する（記録が変わる人だけ） */
async function recordCurrentMenu(
    supabase: AdminClient,
    users: UserMenuState[],
    menuId: string | null
) {
    const changed = users.filter(u => u.currentMenuId !== menuId)
    for (const ids of chunk(changed.map(u => u.id), 200)) {
        const { error } = await supabase
            .from('line_users')
            .update({ current_rich_menu_id: menuId })
            .in('id', ids)
        if (error) console.error('現在のリッチメニューの記録に失敗:', error)
    }
}

/**
 * チャンネルのリッチメニューを、設定どおりに LINE へ反映する。
 *
 * 1. 使用中（全員向け・タグ連動・表示期間あり）のメニューで、LINE に未反映・LINE から消えている・
 *    内容を編集したものを LINE に作る（作り直す）
 * 2. 全員向けのメニューを LINE のデフォルトリッチメニューに設定する
 * 3. タグ連動メニューの人には個別にリンクし、それ以外の人の個別リンクは外す
 *    （個別リンクはデフォルトより優先されるため、残っているとデフォルトを変えても切り替わらない）
 * 4. 作り直したメニューの古い版を LINE から消す
 */
export async function syncChannelRichMenus(
    channelId: string,
    options: RichMenuSyncOptions = {}
): Promise<RichMenuSyncResult> {
    const supabase = createAdminClient()
    const now = new Date()
    const result: RichMenuSyncResult = {
        allUsersMenu: null,
        linked: 0,
        unlinked: 0,
        failed: 0,
        published: [],
        failedMenus: [],
        warnings: [],
    }

    const { data: channel, error: channelError } = await supabase
        .from('channels')
        .select('id, channel_access_token, default_rich_menu_id')
        .eq('id', channelId)
        .single()

    if (channelError || !channel) throw new Error('チャンネルが見つかりません')
    if (!channel.channel_access_token) throw new Error('チャンネルのアクセストークンが設定されていません')

    const lineClient = new LineClient(channel.channel_access_token)

    const { data: menuRows, error: menuError } = await supabase
        .from('rich_menus')
        .select(MENU_COLUMNS)
        .eq('channel_id', channelId)

    if (menuError) throw menuError
    const menus = (menuRows ?? []) as MenuRow[]
    const menuById = new Map(menus.map(m => [m.id, m]))

    const { data: tagRows, error: tagError } = await supabase
        .from('tags')
        .select('id, linked_rich_menu_id, priority')
        .eq('channel_id', channelId)
        .not('linked_rich_menu_id', 'is', null)

    if (tagError) throw tagError
    const linkedTags = (tagRows ?? []).filter(t => menuById.has(t.linked_rich_menu_id))

    // ---- 1. 使うメニューを LINE に反映する ----
    const allUsersChoice = pickAllUsersMenu(menus, now, channel.default_rich_menu_id)

    const inUse = new Set<string>()
    if (allUsersChoice) inUse.add(allUsersChoice.id)
    for (const tag of linkedTags) inUse.add(tag.linked_rich_menu_id)
    // 基本のメニュー（期間メニューの表示中は控え）と表示期間のあるメニューは、切り替わる前に反映しておく。
    // 期間の切り替えがデフォルトの付け替えだけで済むようにするため
    for (const menu of menus) {
        if (menu.image_url && (menu.is_default || hasUpcomingDisplayPeriod(menu, now))) inUse.add(menu.id)
    }

    const edited = new Set(options.editedMenuIds ?? [])
    const mustPublish = new Set(options.publishMenuIds ?? [])
    const relinkMenuIds = new Set<string>()
    /** 作り直した古い版（menuId → LINE のID）。付け替え後に消す */
    const replaced = new Map<string, string>()
    /** LINE から消えていて、作り直せなかったメニュー */
    const unusable = new Set<string>()

    for (const menu of menus) {
        const used = inUse.has(menu.id)
        const missing = used && menu.rich_menu_id ? await isMissingOnLine(lineClient, menu.rich_menu_id) : false

        const needsPublish =
            mustPublish.has(menu.id) ||
            (edited.has(menu.id) && (used || Boolean(menu.rich_menu_id))) ||
            (used && (!menu.rich_menu_id || missing))

        if (!needsPublish) continue

        try {
            const published = await publishMenu(supabase, lineClient, menu)

            if (!published) {
                // 同時に別の操作が作り直した。そちらの版を使う
                const { data: latest } = await supabase
                    .from('rich_menus')
                    .select('rich_menu_id')
                    .eq('id', menu.id)
                    .single()
                menu.rich_menu_id = latest?.rich_menu_id ?? null
                continue
            }

            if (menu.rich_menu_id && !missing) replaced.set(menu.id, menu.rich_menu_id)
            menu.rich_menu_id = published.lineRichMenuId
            relinkMenuIds.add(menu.id)
            result.published.push({
                id: menu.id,
                name: menu.name,
                skippedAreaNumbers: published.skippedAreaNumbers,
            })
        } catch (err) {
            const message = errorMessage(err)
            console.error(`リッチメニューのLINE反映エラー: ${menu.name}`, err)
            result.failedMenus.push({ id: menu.id, name: menu.name, message })
            result.warnings.push(`「${menu.name}」をLINEに反映できませんでした: ${message}`)
            if (missing) unusable.add(menu.id)
        }
    }

    const usableMenuIds = new Set(
        menus.filter(m => m.rich_menu_id && !unusable.has(m.id)).map(m => m.id)
    )

    // ---- 2. 全員向けメニューを LINE のデフォルトに設定する ----
    let defaultApplied = true
    const allUsersMenu = allUsersChoice ? menuById.get(allUsersChoice.id) : undefined

    if (allUsersChoice && allUsersMenu) {
        if (usableMenuIds.has(allUsersMenu.id) && allUsersMenu.rich_menu_id) {
            try {
                await withRetry(() => lineClient.setDefaultRichMenu(allUsersMenu.rich_menu_id!))
                result.allUsersMenu = { id: allUsersMenu.id, name: allUsersMenu.name, reason: allUsersChoice.reason }
            } catch (err) {
                defaultApplied = false
                result.warnings.push(`全員向けメニュー「${allUsersMenu.name}」の設定に失敗しました: ${errorMessage(err)}`)
            }
        } else {
            defaultApplied = false
        }
    } else {
        // 全員向けのメニューがない。このツールで設定したデフォルトが残っていれば外す
        // （LINE公式アカウントマネージャーで設定したメニューが表示されるようになる）
        try {
            const current = await lineClient.getDefaultRichMenuId()
            const ownLineIds = new Set([
                ...menus.map(m => m.rich_menu_id).filter((id): id is string => Boolean(id)),
                ...replaced.values(),
            ])
            if (current && ownLineIds.has(current)) {
                await lineClient.cancelDefaultRichMenu()
            }
        } catch (err) {
            result.warnings.push(`デフォルトメニューの解除に失敗しました: ${errorMessage(err)}`)
        }
    }

    // ---- 3. 一人ひとりの個別設定を揃える ----
    const users = await fetchAllRows<{ id: string; line_user_id: string; current_rich_menu_id: string | null }>(
        (from, to) => supabase
            .from('line_users')
            .select('id, line_user_id, current_rich_menu_id')
            .eq('channel_id', channelId)
            .or('is_blocked.is.null,is_blocked.eq.false')
            .order('id')
            .range(from, to)
    )

    const tagById = new Map(linkedTags.map(t => [t.id, t]))
    const tagsByUser = new Map<string, TagMenuCandidate[]>()

    if (linkedTags.length > 0) {
        const userTags = await fetchAllRows<{ line_user_id: string; tag_id: string }>(
            (from, to) => supabase
                .from('line_user_tags')
                .select('line_user_id, tag_id')
                .in('tag_id', linkedTags.map(t => t.id))
                .order('id')
                .range(from, to)
        )

        for (const userTag of userTags) {
            const tag = tagById.get(userTag.tag_id)
            if (!tag) continue
            const list = tagsByUser.get(userTag.line_user_id) ?? []
            list.push({ tagId: tag.id, linkedMenuId: tag.linked_rich_menu_id, priority: tag.priority })
            tagsByUser.set(userTag.line_user_id, list)
        }
    }

    const states: UserMenuState[] = users.map(user => ({
        id: user.id,
        lineUserId: user.line_user_id,
        currentMenuId: user.current_rich_menu_id,
        targetMenuId: pickTagMenuId(tagsByUser.get(user.id) ?? [], usableMenuIds),
    }))

    const plan = planRichMenuLinks(states, { force: options.force, relinkMenuIds })

    for (const [menuId, group] of plan.link) {
        const lineRichMenuId = menuById.get(menuId)?.rich_menu_id
        if (!lineRichMenuId) continue

        for (const part of chunk(group, BULK_LIMIT)) {
            const succeeded = await sendInBulk(
                part,
                ids => lineClient.linkRichMenuToUsers(ids, lineRichMenuId),
                id => lineClient.linkRichMenuToUser(id, lineRichMenuId)
            )
            result.linked += succeeded.length
            result.failed += part.length - succeeded.length
            await recordCurrentMenu(supabase, succeeded, menuId)
        }
    }

    for (const part of chunk(plan.unlink, BULK_LIMIT)) {
        const succeeded = await sendInBulk(
            part,
            ids => lineClient.unlinkRichMenuFromUsers(ids),
            id => lineClient.unlinkRichMenuFromUser(id)
        )
        result.unlinked += succeeded.length
        result.failed += part.length - succeeded.length
        await recordCurrentMenu(supabase, succeeded, null)
    }

    if (result.failed > 0) {
        result.warnings.push(
            `${result.failed}人にはLINEへの切り替えを送れませんでした（ブロック・退会した人には送れません）。` +
            'ほとんどの人が切り替わっていない場合は、時間をおいて「LINEと揃え直す」を押してください。'
        )
    }

    // ---- 4. 作り直したメニューの古い版を消す ----
    for (const [menuId, oldLineId] of replaced) {
        // デフォルトの付け替えに失敗した全員向けメニューは、古い版を残しておく（消すと何も出なくなる）
        if (!defaultApplied && menuId === allUsersMenu?.id) continue
        try {
            await lineClient.deleteRichMenu(oldLineId)
        } catch (err) {
            console.error(`古いリッチメニューの削除に失敗: ${oldLineId}`, err)
        }
    }

    return result
}

/**
 * 表示期間に合わせて、全員向けメニュー（LINE のデフォルト）を切り替える。定期処理から呼ぶ。
 *
 * 実際に LINE に設定されているデフォルトと比べて違うときだけ設定し直すので、
 * 何度呼んでも安全で、手作業などでずれた場合も元に戻る。
 */
export async function syncScheduledRichMenus(
    supabase: AdminClient = createAdminClient()
): Promise<{ channelId: string; action: string; menuName?: string }[]> {
    const now = new Date()
    const results: { channelId: string; action: string; menuName?: string }[] = []

    const { data: menuRows, error } = await supabase.from('rich_menus').select(MENU_COLUMNS)
    if (error) throw error

    const menusByChannel = new Map<string, MenuRow[]>()
    for (const menu of (menuRows ?? []) as MenuRow[]) {
        const list = menusByChannel.get(menu.channel_id) ?? []
        list.push(menu)
        menusByChannel.set(menu.channel_id, list)
    }

    if (menusByChannel.size === 0) return results

    const { data: channels, error: channelError } = await supabase
        .from('channels')
        .select('id, channel_access_token, default_rich_menu_id')
        .in('id', [...menusByChannel.keys()])

    if (channelError) throw channelError

    for (const channel of channels ?? []) {
        if (!channel.channel_access_token) continue
        const menus = menusByChannel.get(channel.id) ?? []
        const choice = pickAllUsersMenu(menus, now, channel.default_rich_menu_id)
        // 全員向けも、このツールで設定したデフォルトもないチャンネルは LINE に問い合わせない
        if (!choice && !menus.some(m => m.rich_menu_id)) continue

        const lineClient = new LineClient(channel.channel_access_token)

        try {
            const current = await lineClient.getDefaultRichMenuId()

            if (choice) {
                const menu = menus.find(m => m.id === choice.id)!
                if (!menu.rich_menu_id || (current !== menu.rich_menu_id && await isMissingOnLine(lineClient, menu.rich_menu_id))) {
                    const published = await publishMenu(supabase, lineClient, menu)
                    if (!published) continue
                    menu.rich_menu_id = published.lineRichMenuId
                }

                if (current !== menu.rich_menu_id) {
                    await lineClient.setDefaultRichMenu(menu.rich_menu_id)
                    results.push({
                        channelId: channel.id,
                        action: choice.reason === 'period' ? 'period_menu_applied' : 'default_menu_applied',
                        menuName: menu.name,
                    })
                }
            } else if (current && menus.some(m => m.rich_menu_id === current)) {
                await lineClient.cancelDefaultRichMenu()
                results.push({ channelId: channel.id, action: 'default_menu_cleared' })
            }
        } catch (err) {
            console.error(`リッチメニューの期間切替エラー (チャンネル: ${channel.id}):`, err)
            results.push({ channelId: channel.id, action: 'error' })
        }
    }

    return results
}

export type RichMenuRuleChanges = {
    /** 全員向け（基本）のメニュー。null で「なし」、undefined で変更しない */
    defaultMenuId?: string | null
    /** タグごとのメニュー。menuId が null でそのタグの紐付けを外す */
    tagMenus?: { tagId: string; menuId: string | null }[]
    /** このメニューを使うタグをまとめて指定する（指定外のタグからは外す） */
    menuTags?: { menuId: string; tagIds: string[] }
}

/**
 * 「誰にどのメニューを見せるか」の設定を DB に保存する（LINE への反映は syncChannelRichMenus で行う）
 */
export async function saveRichMenuRules(
    supabase: AdminClient,
    channelId: string,
    changes: RichMenuRuleChanges
): Promise<void> {
    if (changes.defaultMenuId !== undefined) {
        // 基本のメニューは1つだけ
        let clear = supabase
            .from('rich_menus')
            .update({ is_default: false })
            .eq('channel_id', channelId)
        if (changes.defaultMenuId) clear = clear.neq('id', changes.defaultMenuId)
        const { error: clearError } = await clear
        if (clearError) throw clearError

        if (changes.defaultMenuId) {
            const { error } = await supabase
                .from('rich_menus')
                .update({ is_default: true })
                .eq('id', changes.defaultMenuId)
                .eq('channel_id', channelId)
            if (error) throw error
        }

        const { error: channelError } = await supabase
            .from('channels')
            .update({ default_rich_menu_id: changes.defaultMenuId })
            .eq('id', channelId)
        if (channelError) throw channelError
    }

    for (const { tagId, menuId } of changes.tagMenus ?? []) {
        const { error } = await supabase
            .from('tags')
            .update({ linked_rich_menu_id: menuId })
            .eq('id', tagId)
            .eq('channel_id', channelId)
        if (error) throw error
    }

    if (changes.menuTags) {
        const { menuId, tagIds } = changes.menuTags

        let detach = supabase
            .from('tags')
            .update({ linked_rich_menu_id: null })
            .eq('channel_id', channelId)
            .eq('linked_rich_menu_id', menuId)
        if (tagIds.length > 0) detach = detach.not('id', 'in', `(${tagIds.join(',')})`)
        const { error: detachError } = await detach
        if (detachError) throw detachError

        if (tagIds.length > 0) {
            const { error } = await supabase
                .from('tags')
                .update({ linked_rich_menu_id: menuId })
                .eq('channel_id', channelId)
                .in('id', tagIds)
            if (error) throw error
        }
    }
}
