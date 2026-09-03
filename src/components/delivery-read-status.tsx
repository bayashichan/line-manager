'use client'

import { useCallback, useEffect, useState } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Loader2, CheckCheck, Circle, AlertTriangle } from 'lucide-react'
import { formatDateTime } from '@/lib/utils'

/**
 * 配信ごと・友だちごとの既読状況。
 *
 * 【既読の考え方】
 * LINE Messaging API には既読を知る手段が無い（通知イベントも取得APIも存在しない）。
 * そのため本システムでは「配信のあとに友だちから反応があったか」で判定している。
 *   既読 = 配信後に返信・ボタンタップ・リンクタップのいずれかがあった
 *   未読 = 届いてはいるが、上記の反応がまだ確認できていない
 * 未読は「読んでいない」ではなく「確認できていない」である点を画面にも明記する。
 */

type RecipientRow = {
    id: string
    status: 'pending' | 'sent' | 'failed'
    error_message: string | null
    sent_at: string | null
    read_at: string | null
    read_source: string | null
    line_users: {
        id: string
        display_name: string | null
        internal_name: string | null
        picture_url: string | null
    } | null
}

type Counts = {
    total: number
    sent: number
    failed: number
    read: number
    unread: number
}

type Filter = 'all' | 'read' | 'unread' | 'failed'

const FILTER_LABELS: Record<Filter, string> = {
    all: 'すべて',
    read: '既読',
    unread: '未確認',
    failed: '失敗',
}

const READ_SOURCE_LABELS: Record<string, string> = {
    message: '返信あり',
    postback: 'ボタン操作',
    link_click: 'リンクタップ',
    other: '反応あり',
}

const PAGE_SIZE = 50

export function DeliveryReadStatus({ messageId }: { messageId: string }) {
    const [filter, setFilter] = useState<Filter>('all')
    const [counts, setCounts] = useState<Counts | null>(null)
    const [rows, setRows] = useState<RecipientRow[]>([])
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async (nextFilter: Filter, offset: number) => {
        const res = await fetch(
            `/api/messages/${messageId}/recipients?status=${nextFilter}&limit=${PAGE_SIZE}&offset=${offset}`
        )
        if (!res.ok) {
            const detail = await res.json().catch(() => ({}))
            throw new Error(detail.error || '既読状況を取得できませんでした')
        }
        return res.json()
    }, [messageId])

    useEffect(() => {
        let cancelled = false

        setLoading(true)
        setError(null)

        load(filter, 0)
            .then(data => {
                if (cancelled) return
                setCounts(data.counts)
                setRows(data.recipients)
                setHasMore(data.hasMore)
            })
            .catch((err: Error) => {
                if (!cancelled) setError(err.message)
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })

        return () => { cancelled = true }
    }, [filter, load])

    async function loadMore() {
        setLoadingMore(true)
        try {
            const data = await load(filter, rows.length)
            setRows(prev => [...prev, ...data.recipients])
            setHasMore(data.hasMore)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setLoadingMore(false)
        }
    }

    if (loading) {
        return (
            <div className="flex items-center gap-2 py-4 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                既読状況を読み込み中...
            </div>
        )
    }

    if (error) {
        return <p className="py-3 text-sm text-red-600 dark:text-red-400">{error}</p>
    }

    // この機能より前に配信したものは対象者の記録が無い
    if (!counts || counts.total === 0) {
        return (
            <p className="py-3 text-sm text-slate-500">
                この配信には友だちごとの記録がありません。既読状況は、この機能を追加したあとの配信から記録されます。
            </p>
        )
    }

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
                <StatChip label="配信" value={counts.sent} tone="slate" />
                <StatChip label="既読" value={counts.read} tone="emerald" />
                <StatChip label="未確認" value={counts.unread} tone="amber" />
                {counts.failed > 0 && <StatChip label="失敗" value={counts.failed} tone="red" />}
            </div>

            <p className="text-xs text-slate-500 leading-relaxed">
                LINEは既読を通知しないため、配信後の反応（返信・ボタン操作・リンクタップ）を根拠に既読と判定しています。
                「未確認」は読んでいないという意味ではなく、反応がまだ無い状態です。
            </p>

            <div className="flex flex-wrap gap-1.5">
                {(Object.keys(FILTER_LABELS) as Filter[]).map(key => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setFilter(key)}
                        className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${filter === key
                            ? 'bg-emerald-500 text-white border-emerald-500'
                            : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                            }`}
                    >
                        {FILTER_LABELS[key]}
                    </button>
                ))}
            </div>

            {rows.length === 0 ? (
                <p className="py-2 text-sm text-slate-500">該当する友だちはいません。</p>
            ) : (
                <ul className="divide-y divide-slate-200 dark:divide-slate-700 rounded-lg border border-slate-200 dark:border-slate-700 max-h-96 overflow-y-auto">
                    {rows.map(row => (
                        <li key={row.id} className="flex items-center gap-3 p-2.5">
                            <Avatar className="h-8 w-8 shrink-0">
                                <AvatarImage src={row.line_users?.picture_url || undefined} />
                                <AvatarFallback>
                                    {(row.line_users?.display_name || row.line_users?.internal_name || '?').slice(0, 2)}
                                </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate text-slate-800 dark:text-slate-100">
                                    {row.line_users?.display_name || row.line_users?.internal_name || '名前未取得'}
                                </p>
                                <p className="text-xs text-slate-500 truncate">
                                    {row.status === 'failed'
                                        ? row.error_message || '配信に失敗しました'
                                        : row.read_at
                                            ? `${formatDateTime(row.read_at)}${row.read_source ? `・${READ_SOURCE_LABELS[row.read_source] ?? '反応あり'}` : ''}`
                                            : row.sent_at
                                                ? `${formatDateTime(row.sent_at)}に配信`
                                                : ''}
                                </p>
                            </div>
                            <StatusBadge row={row} />
                        </li>
                    ))}
                </ul>
            )}

            {hasMore && (
                <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                    さらに読み込む
                </Button>
            )}
        </div>
    )
}

function StatusBadge({ row }: { row: RecipientRow }) {
    if (row.status === 'failed') {
        return (
            <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400 shrink-0">
                <AlertTriangle className="w-3.5 h-3.5" />
                失敗
            </span>
        )
    }
    if (row.read_at) {
        return (
            <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 shrink-0">
                <CheckCheck className="w-3.5 h-3.5" />
                既読
            </span>
        )
    }
    return (
        <span className="flex items-center gap-1 text-xs text-slate-400 shrink-0">
            <Circle className="w-3 h-3" />
            未確認
        </span>
    )
}

const TONE_CLASSES: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
    emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

function StatChip({ label, value, tone }: { label: string; value: number; tone: string }) {
    return (
        <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${TONE_CLASSES[tone]}`}>
            {label} {value}
        </span>
    )
}
