'use client'

import { useState } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import type { RichMenu, Tag } from '@/types'
import { hasUpcomingDisplayPeriod, isInDisplayPeriod, pickAllUsersMenu } from '@/lib/rich-menu/plan'
import { CalendarClock, Loader2, Plus, RefreshCw, Tag as TagIcon, Users, X } from 'lucide-react'

/** 表示期間などを「10/1 9:00」形式で出す */
export function formatMenuDate(value: string | null | undefined): string {
    if (!value) return ''
    const date = new Date(value)
    if (isNaN(date.getTime())) return ''
    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 選択肢に、いま設定中のメニュー（画像がなく通常は選べないもの）も含める */
function withCurrent(options: RichMenu[], current: RichMenu | null | undefined): RichMenu[] {
    return current && !options.some(m => m.id === current.id) ? [current, ...options] : options
}

const selectClass =
    'h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900'

type Props = {
    menus: RichMenu[]
    tags: Tag[]
    applying: boolean
    onSetDefault: (menuId: string | null) => void
    onSetTagMenu: (tagId: string, menuId: string | null) => void
    onResync: () => void
}

/**
 * 「誰に・どのリッチメニューを見せるか」を1画面で設定するパネル。
 * 選んだ時点で LINE に反映する（保存ボタンはない）。
 */
export function RichMenuRulesPanel({ menus, tags, applying, onSetDefault, onSetTagMenu, onResync }: Props) {
    const [newTagId, setNewTagId] = useState('')
    const [newTagMenuId, setNewTagMenuId] = useState('')

    const now = new Date()
    const selectableMenus = menus.filter(m => m.image_url)
    const defaultMenu = menus.find(m => m.is_default) ?? null
    const showing = pickAllUsersMenu(menus, now)
    const periodMenu = showing?.reason === 'period' ? menus.find(m => m.id === showing.id) : null
    const upcomingPeriodMenus = menus
        .filter(m => hasUpcomingDisplayPeriod(m, now) && !isInDisplayPeriod(m, now))
        .sort((a, b) => (a.display_period_start ?? '').localeCompare(b.display_period_start ?? ''))

    const menuById = new Map(menus.map(m => [m.id, m]))
    const tagRules = tags
        .filter(t => t.linked_rich_menu_id && menuById.has(t.linked_rich_menu_id))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name, 'ja'))
    const unassignedTags = tags.filter(t => !t.linked_rich_menu_id || !menuById.has(t.linked_rich_menu_id))

    const addTagRule = () => {
        if (!newTagId || !newTagMenuId) return
        onSetTagMenu(newTagId, newTagMenuId)
        setNewTagId('')
        setNewTagMenuId('')
    }

    return (
        <Card className="relative">
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <CardTitle>誰に・どのメニューを見せるか</CardTitle>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        選ぶとすぐにLINEへ反映されます（登録・解除の操作は不要です）。
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={onResync}
                    disabled={applying}
                    title="全員の表示をこの設定どおりにLINEへ送り直します。表示がおかしいときに押してください。"
                >
                    {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    LINEと揃え直す
                </Button>
            </CardHeader>

            <CardContent className="space-y-6">
                {/* 全員向け */}
                <section className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                        <Users className="h-4 w-4 text-emerald-600" />
                        全員（タグ別の設定がない人）
                    </div>
                    <select
                        value={defaultMenu?.id ?? ''}
                        onChange={e => onSetDefault(e.target.value || null)}
                        disabled={applying}
                        className={selectClass}
                    >
                        <option value="">表示しない（LINE公式アカウントマネージャーの設定に従う）</option>
                        {withCurrent(selectableMenus, defaultMenu).map(menu => (
                            <option key={menu.id} value={menu.id}>{menu.name}</option>
                        ))}
                    </select>

                    {periodMenu && (
                        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
                            いまは表示期間中の「{periodMenu.name}」を全員に表示しています（{formatMenuDate(periodMenu.display_period_end)}まで）。
                            期間が終わると自動で上のメニューに戻ります。
                        </p>
                    )}
                    {upcomingPeriodMenus.map(menu => (
                        <p key={menu.id} className="flex items-start gap-2 text-xs text-slate-500">
                            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
                            予定: 「{menu.name}」を {formatMenuDate(menu.display_period_start)}〜{formatMenuDate(menu.display_period_end)} に全員へ表示
                        </p>
                    ))}
                </section>

                {/* タグ別 */}
                <section className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                        <TagIcon className="h-4 w-4 text-emerald-600" />
                        タグ別（タグが付いている人には、全員向けより優先して表示）
                    </div>

                    {tagRules.length === 0 && (
                        <p className="text-xs text-slate-500">まだありません。下から「タグ」と「メニュー」を選んで追加できます。</p>
                    )}

                    <div className="space-y-2">
                        {tagRules.map(tag => (
                            <div
                                key={tag.id}
                                className="flex flex-col gap-2 rounded-lg border border-slate-200 p-2 sm:flex-row sm:items-center dark:border-slate-700"
                            >
                                <div className="flex min-w-0 items-center gap-2 sm:w-56 sm:shrink-0">
                                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                                    <span className="truncate text-sm font-medium">{tag.name}</span>
                                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800">
                                        優先度 {tag.priority ?? 0}
                                    </span>
                                </div>
                                <div className="flex flex-1 items-center gap-2">
                                    <select
                                        value={tag.linked_rich_menu_id ?? ''}
                                        onChange={e => onSetTagMenu(tag.id, e.target.value || null)}
                                        disabled={applying}
                                        className={selectClass}
                                    >
                                        {withCurrent(selectableMenus, menuById.get(tag.linked_rich_menu_id!)).map(menu => (
                                            <option key={menu.id} value={menu.id}>{menu.name}</option>
                                        ))}
                                    </select>
                                    <button
                                        onClick={() => onSetTagMenu(tag.id, null)}
                                        disabled={applying}
                                        className="shrink-0 rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
                                        title="このタグのメニュー設定を外す（全員向けに戻す）"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {unassignedTags.length > 0 && selectableMenus.length > 0 && (
                        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-slate-300 p-2 sm:flex-row sm:items-center dark:border-slate-600">
                            <select
                                value={newTagId}
                                onChange={e => setNewTagId(e.target.value)}
                                disabled={applying}
                                className={selectClass}
                            >
                                <option value="">タグを選ぶ</option>
                                {unassignedTags.map(tag => (
                                    <option key={tag.id} value={tag.id}>{tag.name}（優先度 {tag.priority ?? 0}）</option>
                                ))}
                            </select>
                            <select
                                value={newTagMenuId}
                                onChange={e => setNewTagMenuId(e.target.value)}
                                disabled={applying}
                                className={selectClass}
                            >
                                <option value="">メニューを選ぶ</option>
                                {selectableMenus.map(menu => (
                                    <option key={menu.id} value={menu.id}>{menu.name}</option>
                                ))}
                            </select>
                            <Button
                                size="sm"
                                onClick={addTagRule}
                                disabled={applying || !newTagId || !newTagMenuId}
                                className="shrink-0"
                            >
                                <Plus className="h-4 w-4" />
                                追加
                            </Button>
                        </div>
                    )}

                    {tagRules.length > 1 && (
                        <p className="text-xs text-slate-500">
                            複数のタグが付いている人には、上（優先度が高いタグ）のメニューが表示されます。優先度はタグ管理で変更できます。
                        </p>
                    )}
                </section>

                <p className="text-xs text-slate-400">
                    スマホ側はトーク画面を開き直すと切り替わります（LINEの反映に数秒かかることがあります）。
                </p>
            </CardContent>

            {applying && (
                <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/60 dark:bg-slate-900/60">
                    <span className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm text-slate-600 shadow dark:bg-slate-800 dark:text-slate-300">
                        <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
                        LINEに反映しています…
                    </span>
                </div>
            )}
        </Card>
    )
}
