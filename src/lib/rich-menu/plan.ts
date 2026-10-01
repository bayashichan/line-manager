/**
 * 「誰に・どのリッチメニューを見せるか」を決める純粋なロジック。
 * 画面（表示ルールの説明）とサーバー（LINE への反映）の両方から使う。
 *
 * LINE の表示の優先順位は「ユーザー個別のリンク ＞ デフォルトリッチメニュー」。
 * そのため、
 * - 全員向け（デフォルト / 表示期間中のメニュー）は LINE のデフォルトリッチメニューとして1回だけ設定し、
 *   ユーザーには個別リンクを付けない（付けるとデフォルトを変えても古いメニューのままになる）
 * - タグ連動のメニューだけを、そのタグの人に個別リンクする
 */

/** 全員向けメニューを決めるのに必要な項目 */
export type AllUsersMenuCandidate = {
    id: string
    is_default: boolean | null
    image_url: string | null
    display_period_start: string | null
    display_period_end: string | null
    created_at: string
}

export type AllUsersMenuChoice = {
    id: string
    /** period: 表示期間中のメニュー / default: 基本のメニュー */
    reason: 'period' | 'default'
}

/** 表示期間が「今」に掛かっているか */
export function isInDisplayPeriod(
    menu: Pick<AllUsersMenuCandidate, 'display_period_start' | 'display_period_end'>,
    now: Date
): boolean {
    if (!menu.display_period_start || !menu.display_period_end) return false
    const start = new Date(menu.display_period_start).getTime()
    const end = new Date(menu.display_period_end).getTime()
    const t = now.getTime()
    return !isNaN(start) && !isNaN(end) && start <= t && t <= end
}

/** 表示期間が設定されていて、まだ終わっていない（今または今後表示される）か */
export function hasUpcomingDisplayPeriod(
    menu: Pick<AllUsersMenuCandidate, 'display_period_start' | 'display_period_end'>,
    now: Date
): boolean {
    if (!menu.display_period_start || !menu.display_period_end) return false
    const end = new Date(menu.display_period_end).getTime()
    return !isNaN(end) && now.getTime() <= end
}

/**
 * 全員向け（タグ連動メニューがない人向け）に表示するメニューを決める。
 * 優先順: 表示期間中のメニュー（新しく作ったもの優先） ＞ 基本のメニュー（is_default）
 *
 * @param fallbackDefaultMenuId is_default のメニューがない場合に使う channels.default_rich_menu_id
 */
export function pickAllUsersMenu(
    menus: AllUsersMenuCandidate[],
    now: Date,
    fallbackDefaultMenuId: string | null = null
): AllUsersMenuChoice | null {
    const periodMenu = menus
        .filter(m => m.image_url && isInDisplayPeriod(m, now))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]

    if (periodMenu) return { id: periodMenu.id, reason: 'period' }

    const defaultMenu =
        menus.find(m => m.is_default) ??
        (fallbackDefaultMenuId ? menus.find(m => m.id === fallbackDefaultMenuId) : undefined)

    return defaultMenu ? { id: defaultMenu.id, reason: 'default' } : null
}

/** ユーザーに付いているタグのうち、メニューが紐付いているもの */
export type TagMenuCandidate = {
    tagId: string
    linkedMenuId: string | null
    priority: number | null
}

/**
 * タグ連動で個別に付けるメニューを決める（なければ null = 全員向けに従う）。
 * 優先度が高いタグを優先し、同じ優先度ならタグIDで決める（実行ごとに結果が変わらないように）。
 *
 * @param usableMenuIds LINE に反映済みで、実際に付けられるメニュー
 */
export function pickTagMenuId(
    tags: TagMenuCandidate[],
    usableMenuIds: ReadonlySet<string>
): string | null {
    const candidates = tags
        .filter((t): t is TagMenuCandidate & { linkedMenuId: string } =>
            Boolean(t.linkedMenuId && usableMenuIds.has(t.linkedMenuId)))
        .sort((a, b) =>
            (b.priority ?? 0) - (a.priority ?? 0) || a.tagId.localeCompare(b.tagId))

    return candidates[0]?.linkedMenuId ?? null
}

export type UserMenuState = {
    /** line_users.id */
    id: string
    /** LINE のユーザーID */
    lineUserId: string
    /** DB に記録している個別リンク中のメニュー（null = 全員向けに従っている） */
    currentMenuId: string | null
    /** 本来付けるべき個別メニュー（null = 個別設定を外して全員向けに従わせる） */
    targetMenuId: string | null
}

export type RichMenuLinkPlan = {
    /** メニューID → そのメニューを個別リンクする人 */
    link: Map<string, UserMenuState[]>
    /** 個別リンクを外す人 */
    unlink: UserMenuState[]
}

/**
 * LINE に送る変更を決める。
 *
 * @param options.force 記録上は同じでも全員に送り直す。LINE 側の表示と DB の記録が
 *   ずれていても（過去に記録なしで付けたリンクなど）これで揃う
 * @param options.relinkMenuIds LINE 上で作り直したメニュー。記録が同じでも付け直す
 */
export function planRichMenuLinks(
    users: UserMenuState[],
    options: { force?: boolean; relinkMenuIds?: ReadonlySet<string> } = {}
): RichMenuLinkPlan {
    const link = new Map<string, UserMenuState[]>()
    const unlink: UserMenuState[] = []

    for (const user of users) {
        const changed = user.targetMenuId !== user.currentMenuId
        const relink = Boolean(user.targetMenuId && options.relinkMenuIds?.has(user.targetMenuId))
        if (!options.force && !changed && !relink) continue

        if (user.targetMenuId) {
            const group = link.get(user.targetMenuId) ?? []
            group.push(user)
            link.set(user.targetMenuId, group)
        } else {
            unlink.push(user)
        }
    }

    return { link, unlink }
}

/** 配列を size 件ずつに分ける */
export function chunk<T>(items: T[], size: number): T[][] {
    const result: T[][] = []
    for (let i = 0; i < items.length; i += size) {
        result.push(items.slice(i, i + size))
    }
    return result
}
