'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { Button, Input, Card, CardContent } from '@/components/ui'
import { formatDateTime, getCookie } from '@/lib/utils'
import type { Applicant } from '@/types'
import {
    Search,
    Loader2,
    AlertCircle,
    UserX,
    UserCheck,
    MessageCircle,
    Download,
    Copy,
    Check,
} from 'lucide-react'

/**
 * 申込者一覧。
 *
 * 外部の申込フォームから連携された申込者を、公式アカウントの友だちかどうかで
 * 振り分けて表示する。LIFFのログインは「認証」であって友だち追加ではないため、
 * 申込は済んでいるが友だちではない人が発生する。その人たちを取りこぼさず
 * 追跡できるようにするのがこの画面の目的。
 */
export default function ApplicantsPage() {
    const router = useRouter()
    const [applicants, setApplicants] = useState<Applicant[]>([])
    const [loading, setLoading] = useState(true)
    const [listLoading, setListLoading] = useState(false)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [showFriends, setShowFriends] = useState(false)
    const [notFriendCount, setNotFriendCount] = useState(0)
    const [friendCount, setFriendCount] = useState(0)
    const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)
    const [copiedId, setCopiedId] = useState<string | null>(null)

    const fetchChannelAndData = async () => {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) return

        const savedChannelId = getCookie('line-manager-channel-id')

        let query = supabase
            .from('channel_members')
            .select('channel_id')
            .eq('profile_id', user.id)

        query = savedChannelId ? query.eq('channel_id', savedChannelId) : query.limit(1)

        const { data: memberships } = await query

        if (memberships && memberships.length > 0) {
            const channelId = memberships[0].channel_id
            setCurrentChannelId(channelId)
            await fetchData(channelId)
        }

        setLoading(false)
    }

    const fetchData = async (channelId: string, friendView: boolean = showFriends) => {
        const supabase = createClient()

        setListLoading(true)
        setLoadError(null)

        // 1000行上限に当たらないようページングして全件取得する
        const { data, error } = await fetchAllRows<Applicant>((from, to) =>
            supabase
                .from('applicants')
                .select('*')
                .eq('channel_id', channelId)
                .eq('is_friend', friendView)
                .order('created_at', { ascending: false })
                .order('id', { ascending: true })
                .range(from, to)
        )

        if (error) {
            console.error('申込者一覧の取得エラー:', error)
            setLoadError('申込者一覧の取得に失敗しました。時間をおいて再読み込みしてください。')
        }

        setApplicants(data)
        setListLoading(false)

        const [notFriendResult, friendResult] = await Promise.all([
            supabase
                .from('applicants')
                .select('id', { count: 'exact', head: true })
                .eq('channel_id', channelId)
                .eq('is_friend', false),
            supabase
                .from('applicants')
                .select('id', { count: 'exact', head: true })
                .eq('channel_id', channelId)
                .eq('is_friend', true),
        ])

        setNotFriendCount(notFriendResult.count ?? 0)
        setFriendCount(friendResult.count ?? 0)
    }

    // 初回のみ実行する（他のダッシュボード画面と同じ方針）
    useEffect(() => {
        fetchChannelAndData()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const handleViewChange = (friendView: boolean) => {
        if (friendView === showFriends) return
        setShowFriends(friendView)
        if (currentChannelId) {
            fetchData(currentChannelId, friendView)
        }
    }

    const filtered = applicants.filter(a => {
        const q = searchQuery.toLowerCase()
        return (
            (a.display_name?.toLowerCase() || '').includes(q) ||
            a.line_user_id.toLowerCase().includes(q) ||
            a.source.toLowerCase().includes(q)
        )
    })

    const copyUserId = async (applicant: Applicant) => {
        try {
            await navigator.clipboard.writeText(applicant.line_user_id)
            setCopiedId(applicant.id)
            setTimeout(() => setCopiedId(null), 1500)
        } catch {
            // クリップボードが使えない環境では何もしない
        }
    }

    const handleExportCSV = () => {
        const headers = ['LINE表示名', 'LINE userId', '申込元', '友だち', '申込日時', '連携日時']
        const rows = filtered.map(a => [
            a.display_name || '',
            a.line_user_id,
            a.source,
            a.is_friend ? '友だち' : '未友だち',
            a.applied_at ? new Date(a.applied_at).toLocaleString('ja-JP') : '',
            new Date(a.created_at).toLocaleString('ja-JP'),
        ])

        const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `applicants${showFriends ? '' : '_not_friend'}_${new Date().toISOString().split('T')[0]}.csv`
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
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                        申込者
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        {filtered.length} / {applicants.length} 人
                        {showFriends ? 'の友だち申込者' : 'の未友だち申込者'}
                        {listLoading && (
                            <Loader2 className="inline w-3 h-3 ml-2 animate-spin text-slate-400" />
                        )}
                    </p>
                </div>
                <Button variant="outline" onClick={handleExportCSV} disabled={filtered.length === 0}>
                    <Download className="w-4 h-4" />
                    CSVエクスポート
                </Button>
            </div>

            {!showFriends && notFriendCount > 0 && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-md bg-amber-50 text-amber-800 text-sm dark:bg-amber-900/20 dark:text-amber-300">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                        この人たちは申込を完了していますが、公式アカウントの友だちではありません。
                        メッセージを送ることができないため、個別に友だち追加をご案内してください。
                    </span>
                </div>
            )}

            {loadError && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-md bg-red-50 text-red-700 text-sm dark:bg-red-900/20 dark:text-red-300">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {loadError}
                </div>
            )}

            {/* 表示切替と検索 */}
            <div className="flex flex-col gap-3">
                <div className="flex gap-2 flex-wrap">
                    <Button
                        variant={showFriends ? 'outline' : 'default'}
                        size="sm"
                        onClick={() => handleViewChange(false)}
                    >
                        <UserX className="w-4 h-4 mr-1" />
                        未友だち（{notFriendCount}）
                    </Button>
                    <Button
                        variant={showFriends ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleViewChange(true)}
                    >
                        <UserCheck className="w-4 h-4 mr-1" />
                        友だち（{friendCount}）
                    </Button>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                        placeholder="表示名・userId・申込元で検索..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                    />
                </div>
            </div>

            {/* 一覧 */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filtered.map(applicant => (
                    <Card key={applicant.id}>
                        <CardContent className="p-4">
                            <div className="flex items-start justify-between gap-2">
                                <h3 className="font-medium truncate">
                                    {applicant.display_name || '名前なし'}
                                </h3>
                                {applicant.is_friend && applicant.linked_line_user_id && (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="shrink-0 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                                        onClick={() =>
                                            router.push(`/dashboard/chats?userId=${applicant.linked_line_user_id}`)
                                        }
                                    >
                                        <MessageCircle className="w-5 h-5" />
                                    </Button>
                                )}
                            </div>

                            <button
                                onClick={() => copyUserId(applicant)}
                                title="userIdをコピー"
                                className="mt-2 flex items-center gap-1 text-xs font-mono text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                            >
                                {copiedId === applicant.id ? (
                                    <Check className="w-3 h-3 text-emerald-500" />
                                ) : (
                                    <Copy className="w-3 h-3" />
                                )}
                                <span className="truncate">{applicant.line_user_id}</span>
                            </button>

                            <div className="flex flex-wrap gap-1 mt-3">
                                <span className="px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                    {applicant.source}
                                </span>
                                <span
                                    className={
                                        applicant.is_friend
                                            ? 'px-2 py-0.5 text-xs rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                                            : 'px-2 py-0.5 text-xs rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                    }
                                >
                                    {applicant.is_friend ? '友だち' : '未友だち'}
                                </span>
                            </div>

                            <p className="text-xs text-slate-400 mt-3">
                                申込: {applicant.applied_at ? formatDateTime(applicant.applied_at) : '不明'}
                            </p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {filtered.length === 0 && !listLoading && (
                <div className="text-center py-12 text-slate-500">
                    {searchQuery
                        ? '検索条件に一致する申込者がいません'
                        : showFriends
                            ? '友だちの申込者はまだいません'
                            : '未友だちの申込者はいません'}
                </div>
            )}
        </div>
    )
}
