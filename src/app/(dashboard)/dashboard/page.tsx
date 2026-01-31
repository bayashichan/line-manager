'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { cn, formatDate, getRelativeTime, getCookie } from '@/lib/utils'
import type { Channel } from '@/types'
import {
    Users,
    MessageCircle,
    LayoutGrid,
    Tag,
    TrendingUp,
    TrendingDown,
    Send,
    UserPlus,
    UserMinus,
    Loader2,
    ArrowRight,
    CheckCircle,
    XCircle,
} from 'lucide-react'
import Link from 'next/link'

interface DashboardStats {
    totalFriends: number
    activeFriends: number
    blockedFriends: number
    newFriendsToday: number
    newFriendsWeek: number
    totalTags: number
    totalRichMenus: number
    totalMessages: number
    successfulDeliveries: number
    failedDeliveries: number
    recentMessages: {
        id: string
        title: string
        status: string
        sent_at: string
        success_count: number
        total_recipients: number
    }[]
    friendGrowth: {
        date: string
        count: number
    }[]
}

export default function DashboardPage() {
    const [stats, setStats] = useState<DashboardStats | null>(null)
    const [channel, setChannel] = useState<Channel | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        fetchStats()
    }, [])

    const fetchStats = async () => {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) return

        // CookieからチャンネルIDを取得
        const savedChannelId = getCookie('line-manager-channel-id')

        // チャンネル取得
        let query = supabase
            .from('channel_members')
            .select('channel_id, channels(*)')
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

        const channelData = memberships[0].channels as unknown as Channel
        setChannel(channelData)
        const channelId = memberships[0].channel_id

        // 今日と今週の日付
        const today = new Date()
        const todayStr = today.toISOString().split('T')[0]
        const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
        const weekAgoStr = weekAgo.toISOString()

        // 友だち統計
        const { count: totalFriends } = await supabase
            .from('line_users')
            .select('*', { count: 'exact', head: true })
            .eq('channel_id', channelId)

        const { count: activeFriends } = await supabase
            .from('line_users')
            .select('*', { count: 'exact', head: true })
            .eq('channel_id', channelId)
            .eq('is_blocked', false)

        const { count: blockedFriends } = await supabase
            .from('line_users')
            .select('*', { count: 'exact', head: true })
            .eq('channel_id', channelId)
            .eq('is_blocked', true)

        const { count: newFriendsToday } = await supabase
            .from('line_users')
            .select('*', { count: 'exact', head: true })
            .eq('channel_id', channelId)
            .gte('followed_at', todayStr)

        const { count: newFriendsWeek } = await supabase
            .from('line_users')
            .select('*', { count: 'exact', head: true })
            .eq('channel_id', channelId)
            .gte('followed_at', weekAgoStr)

        // タグ・リッチメニュー数
        const { count: totalTags } = await supabase
            .from('tags')
            .select('*', { count: 'exact', head: true })
            .eq('channel_id', channelId)

        const { count: totalRichMenus } = await supabase
            .from('rich_menus')
            .select('*', { count: 'exact', head: true })
            .eq('channel_id', channelId)

        // メッセージ統計
        const { data: messagesData } = await supabase
            .from('messages')
            .select('status, success_count, failure_count, total_recipients')
            .eq('channel_id', channelId)

        const totalMessages = messagesData?.length || 0
        const successfulDeliveries = messagesData?.reduce((sum, m) => sum + (m.success_count || 0), 0) || 0
        const failedDeliveries = messagesData?.reduce((sum, m) => sum + (m.failure_count || 0), 0) || 0

        // 最近のメッセージ
        const { data: recentMessages } = await supabase
            .from('messages')
            .select('id, title, status, sent_at, success_count, total_recipients')
            .eq('channel_id', channelId)
            .order('created_at', { ascending: false })
            .limit(5)

        // 友だち増加推移（過去7日間）
        const friendGrowth: { date: string; count: number }[] = []
        for (let i = 6; i >= 0; i--) {
            const date = new Date(today.getTime() - i * 24 * 60 * 60 * 1000)
            const dateStr = date.toISOString().split('T')[0]
            const nextDateStr = new Date(date.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0]

            const { count } = await supabase
                .from('line_users')
                .select('*', { count: 'exact', head: true })
                .eq('channel_id', channelId)
                .gte('followed_at', dateStr)
                .lt('followed_at', nextDateStr)

            friendGrowth.push({ date: dateStr, count: count || 0 })
        }

        setStats({
            totalFriends: totalFriends || 0,
            activeFriends: activeFriends || 0,
            blockedFriends: blockedFriends || 0,
            newFriendsToday: newFriendsToday || 0,
            newFriendsWeek: newFriendsWeek || 0,
            totalTags: totalTags || 0,
            totalRichMenus: totalRichMenus || 0,
            totalMessages,
            successfulDeliveries,
            failedDeliveries,
            recentMessages: recentMessages || [],
            friendGrowth,
        })

        setLoading(false)
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
            </div>
        )
    }

    if (!channel) {
        return (
            <div className="text-center py-12">
                <p className="text-slate-500 mb-4">
                    まだチャンネルが登録されていません
                </p>
                <Link
                    href="/dashboard/channels/new"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors"
                >
                    チャンネルを追加
                </Link>
            </div>
        )
    }

    const deliveryRate = stats && stats.successfulDeliveries + stats.failedDeliveries > 0
        ? Math.round((stats.successfulDeliveries / (stats.successfulDeliveries + stats.failedDeliveries)) * 100)
        : 0

    return (
        <div className="space-y-6">
            {/* ヘッダー */}
            <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                    ダッシュボード
                </h1>
                <p className="text-slate-500 dark:text-slate-400 mt-1">
                    {channel.name}の統計情報
                </p>
            </div>

            {/* 主要統計カード */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                    title="総友だち数"
                    value={stats?.activeFriends || 0}
                    subValue={`+${stats?.newFriendsToday || 0} 今日`}
                    icon={<Users className="w-5 h-5" />}
                    color="emerald"
                    trend={stats?.newFriendsToday && stats.newFriendsToday > 0 ? 'up' : 'neutral'}
                />
                <StatCard
                    title="今週の新規"
                    value={stats?.newFriendsWeek || 0}
                    subValue="過去7日間"
                    icon={<UserPlus className="w-5 h-5" />}
                    color="blue"
                    trend="up"
                />
                <StatCard
                    title="配信成功率"
                    value={`${deliveryRate}%`}
                    subValue={`${stats?.successfulDeliveries || 0}件成功`}
                    icon={<Send className="w-5 h-5" />}
                    color="violet"
                    trend={deliveryRate >= 90 ? 'up' : deliveryRate >= 70 ? 'neutral' : 'down'}
                />
                <StatCard
                    title="タグ数"
                    value={stats?.totalTags || 0}
                    subValue={`リッチメニュー: ${stats?.totalRichMenus || 0}`}
                    icon={<Tag className="w-5 h-5" />}
                    color="amber"
                    trend="neutral"
                />
            </div>

            {/* グラフと詳細 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* 友だち増加グラフ */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <TrendingUp className="w-5 h-5 text-emerald-500" />
                            友だち増加推移（7日間）
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="h-48 flex items-end justify-between gap-2">
                            {stats?.friendGrowth.map((day, i) => {
                                const maxCount = Math.max(...stats.friendGrowth.map(d => d.count), 1)
                                const height = (day.count / maxCount) * 100
                                return (
                                    <div key={i} className="flex-1 flex flex-col items-center gap-2">
                                        <div
                                            className="w-full bg-gradient-to-t from-emerald-500 to-emerald-400 rounded-t-md transition-all duration-300 min-h-[4px]"
                                            style={{ height: `${Math.max(height, 5)}%` }}
                                        />
                                        <div className="text-xs text-slate-500 text-center">
                                            <div className="font-medium">{day.count}</div>
                                            <div>{new Date(day.date).getDate()}日</div>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </CardContent>
                </Card>

                {/* 最近の配信 */}
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                            <MessageCircle className="w-5 h-5 text-blue-500" />
                            最近の配信
                        </CardTitle>
                        <Link
                            href="/dashboard/messages"
                            className="text-sm text-emerald-600 hover:underline flex items-center gap-1"
                        >
                            すべて見る
                            <ArrowRight className="w-4 h-4" />
                        </Link>
                    </CardHeader>
                    <CardContent>
                        {stats?.recentMessages && stats.recentMessages.length > 0 ? (
                            <div className="space-y-3">
                                {stats.recentMessages.map(message => (
                                    <div
                                        key={message.id}
                                        className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg"
                                    >
                                        <div className="flex items-center gap-3">
                                            {message.status === 'sent' ? (
                                                <CheckCircle className="w-5 h-5 text-emerald-500" />
                                            ) : message.status === 'failed' ? (
                                                <XCircle className="w-5 h-5 text-red-500" />
                                            ) : (
                                                <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                                            )}
                                            <div>
                                                <p className="font-medium text-sm">{message.title}</p>
                                                <p className="text-xs text-slate-500">
                                                    {message.sent_at ? getRelativeTime(message.sent_at) : '配信中...'}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="text-right text-sm">
                                            <span className="text-emerald-600">{message.success_count}</span>
                                            <span className="text-slate-400">/{message.total_recipients}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-center py-8 text-slate-500">
                                配信履歴がありません
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* クイックアクセス */}
            <Card>
                <CardHeader>
                    <CardTitle>クイックアクセス</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        <QuickLink
                            href="/dashboard/friends"
                            icon={<Users className="w-6 h-6" />}
                            title="友だち管理"
                            description={`${stats?.activeFriends || 0}人の友だち`}
                            color="emerald"
                        />
                        <QuickLink
                            href="/dashboard/messages"
                            icon={<Send className="w-6 h-6" />}
                            title="メッセージ配信"
                            description="新規配信を作成"
                            color="blue"
                        />
                        <QuickLink
                            href="/dashboard/tags"
                            icon={<Tag className="w-6 h-6" />}
                            title="タグ管理"
                            description={`${stats?.totalTags || 0}個のタグ`}
                            color="violet"
                        />
                        <QuickLink
                            href="/dashboard/rich-menus"
                            icon={<LayoutGrid className="w-6 h-6" />}
                            title="リッチメニュー"
                            description={`${stats?.totalRichMenus || 0}個のメニュー`}
                            color="amber"
                        />
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}

interface StatCardProps {
    title: string
    value: string | number
    subValue: string
    icon: React.ReactNode
    color: 'emerald' | 'blue' | 'violet' | 'amber'
    trend: 'up' | 'down' | 'neutral'
}

function StatCard({ title, value, subValue, icon, color, trend }: StatCardProps) {
    const colorClasses = {
        emerald: 'from-emerald-500 to-green-600',
        blue: 'from-blue-500 to-cyan-600',
        violet: 'from-violet-500 to-purple-600',
        amber: 'from-amber-500 to-orange-600',
    }

    return (
        <Card className="hover:shadow-lg transition-all duration-200">
            <CardContent className="p-4">
                <div className="flex items-start justify-between">
                    <div
                        className={cn(
                            "w-10 h-10 rounded-xl flex items-center justify-center text-white bg-gradient-to-br",
                            colorClasses[color]
                        )}
                    >
                        {icon}
                    </div>
                    {trend === 'up' && <TrendingUp className="w-5 h-5 text-emerald-500" />}
                    {trend === 'down' && <TrendingDown className="w-5 h-5 text-red-500" />}
                </div>
                <div className="mt-4">
                    <p className="text-2xl font-bold">{value}</p>
                    <p className="text-sm text-slate-500 mt-1">{title}</p>
                    <p className="text-xs text-slate-400 mt-1">{subValue}</p>
                </div>
            </CardContent>
        </Card>
    )
}

interface QuickLinkProps {
    href: string
    icon: React.ReactNode
    title: string
    description: string
    color: 'emerald' | 'blue' | 'violet' | 'amber'
}

function QuickLink({ href, icon, title, description, color }: QuickLinkProps) {
    const colorClasses = {
        emerald: 'hover:border-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/10',
        blue: 'hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/10',
        violet: 'hover:border-violet-500 hover:bg-violet-50 dark:hover:bg-violet-900/10',
        amber: 'hover:border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/10',
    }

    const iconColors = {
        emerald: 'text-emerald-500',
        blue: 'text-blue-500',
        violet: 'text-violet-500',
        amber: 'text-amber-500',
    }

    return (
        <Link
            href={href}
            className={cn(
                "flex items-center gap-4 p-4 rounded-xl border-2 border-transparent transition-all duration-200",
                "bg-slate-50 dark:bg-slate-800",
                colorClasses[color]
            )}
        >
            <div className={iconColors[color]}>{icon}</div>
            <div>
                <p className="font-medium">{title}</p>
                <p className="text-sm text-slate-500">{description}</p>
            </div>
        </Link>
    )
}
