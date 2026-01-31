'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { cn, formatDateTime, getCookie } from '@/lib/utils'
import {
    History,
    User,
    Tag,
    Send,
    Settings,
    LayoutGrid,
    Users,
    Download,
    Loader2,
    ChevronLeft,
    ChevronRight,
} from 'lucide-react'

interface ActivityLog {
    id: string
    profile_id: string
    channel_id: string
    action: string
    resource_type: string
    resource_id: string | null
    details: object | null
    created_at: string
    profiles: {
        display_name: string | null
        email: string
    }
}

const ACTION_ICONS: Record<string, React.ReactNode> = {
    'message.send': <Send className="w-4 h-4 text-blue-500" />,
    'tag.create': <Tag className="w-4 h-4 text-emerald-500" />,
    'tag.update': <Tag className="w-4 h-4 text-amber-500" />,
    'tag.delete': <Tag className="w-4 h-4 text-red-500" />,
    'tag.assign': <Tag className="w-4 h-4 text-violet-500" />,
    'rich_menu.create': <LayoutGrid className="w-4 h-4 text-emerald-500" />,
    'rich_menu.update': <LayoutGrid className="w-4 h-4 text-amber-500" />,
    'rich_menu.register': <LayoutGrid className="w-4 h-4 text-blue-500" />,
    'settings.update': <Settings className="w-4 h-4 text-slate-500" />,
    'member.invite': <Users className="w-4 h-4 text-emerald-500" />,
    'member.remove': <Users className="w-4 h-4 text-red-500" />,
}

const ACTION_LABELS: Record<string, string> = {
    'message.send': 'メッセージを配信',
    'tag.create': 'タグを作成',
    'tag.update': 'タグを更新',
    'tag.delete': 'タグを削除',
    'tag.assign': 'タグを付与',
    'tag.unassign': 'タグを解除',
    'rich_menu.create': 'リッチメニューを作成',
    'rich_menu.update': 'リッチメニューを更新',
    'rich_menu.register': 'リッチメニューをLINE APIに登録',
    'rich_menu.delete': 'リッチメニューを削除',
    'settings.update': '設定を更新',
    'member.invite': 'メンバーを招待',
    'member.remove': 'メンバーを削除',
}

export default function LogsPage() {
    const [logs, setLogs] = useState<ActivityLog[]>([])
    const [loading, setLoading] = useState(true)
    const [page, setPage] = useState(1)
    const [hasMore, setHasMore] = useState(false)
    const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)
    const perPage = 20

    useEffect(() => {
        fetchData()
    }, [page])

    const fetchData = async () => {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) return

        // チャンネル取得
        if (!currentChannelId) {
            // CookieからチャンネルIDを取得
            const savedChannelId = getCookie('line-manager-channel-id')

            // チャンネル取得
            let query = supabase
                .from('channel_members')
                .select('channel_id')
                .eq('profile_id', user.id)

            // Cookieがある場合はそのチャンネルを検索
            if (savedChannelId) {
                query = query.eq('channel_id', savedChannelId)
            } else {
                query = query.limit(1)
            }

            const { data: memberships } = await query

            if (!memberships || memberships.length === 0) {
                setLoading(false)
                return
            }

            setCurrentChannelId(memberships[0].channel_id)
        }

        const channelId = currentChannelId

        if (!channelId) {
            setLoading(false)
            return
        }

        // ログ取得
        const { data: logsData, error } = await supabase
            .from('activity_logs')
            .select(`
        *,
        profiles (display_name, email)
      `)
            .eq('channel_id', channelId)
            .order('created_at', { ascending: false })
            .range((page - 1) * perPage, page * perPage)

        if (logsData) {
            setLogs(logsData as ActivityLog[])
            setHasMore(logsData.length > perPage)
        }

        setLoading(false)
    }

    const handleExport = () => {
        const headers = ['日時', 'ユーザー', 'アクション', '詳細']
        const rows = logs.map(log => [
            formatDateTime(log.created_at),
            log.profiles.display_name || log.profiles.email,
            ACTION_LABELS[log.action] || log.action,
            JSON.stringify(log.details || {}),
        ])

        const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `activity_logs_${new Date().toISOString().split('T')[0]}.csv`
        a.click()
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {/* ヘッダー */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                        操作ログ
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        チャンネルの操作履歴を確認
                    </p>
                </div>
                <Button variant="outline" onClick={handleExport}>
                    <Download className="w-4 h-4" />
                    CSVエクスポート
                </Button>
            </div>

            {/* ログ一覧 */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <History className="w-5 h-5" />
                        アクティビティ
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {logs.length > 0 ? (
                        <div className="space-y-3">
                            {logs.map(log => (
                                <div
                                    key={log.id}
                                    className="flex items-start gap-4 p-4 bg-slate-50 dark:bg-slate-800 rounded-xl"
                                >
                                    <div className="w-10 h-10 rounded-full bg-white dark:bg-slate-700 flex items-center justify-center shadow-sm">
                                        {ACTION_ICONS[log.action] || <History className="w-4 h-4 text-slate-400" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-medium">
                                                {log.profiles.display_name || log.profiles.email}
                                            </span>
                                            <span className="text-slate-500">が</span>
                                            <span className="font-medium text-slate-700 dark:text-slate-300">
                                                {ACTION_LABELS[log.action] || log.action}
                                            </span>
                                        </div>
                                        {log.details && Object.keys(log.details).length > 0 && (
                                            <p className="text-sm text-slate-500 mt-1 truncate">
                                                {JSON.stringify(log.details)}
                                            </p>
                                        )}
                                        <p className="text-xs text-slate-400 mt-1">
                                            {formatDateTime(log.created_at)}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center py-12 text-slate-500">
                            操作ログがまだありません
                        </div>
                    )}

                    {/* ページネーション */}
                    {logs.length > 0 && (
                        <div className="flex items-center justify-center gap-4 mt-6">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setPage(p => Math.max(1, p - 1))}
                                disabled={page === 1}
                            >
                                <ChevronLeft className="w-4 h-4" />
                                前へ
                            </Button>
                            <span className="text-sm text-slate-500">ページ {page}</span>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setPage(p => p + 1)}
                                disabled={!hasMore}
                            >
                                次へ
                                <ChevronRight className="w-4 h-4" />
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* 説明 */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800">
                <p className="text-sm text-slate-500">
                    操作ログは、チャンネルに対して行われたすべての操作を記録しています。
                    セキュリティ監査やトラブルシューティングに活用できます。
                </p>
            </div>
        </div>
    )
}
