'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Input, Label } from '@/components/ui'
import type { Channel, Profile } from '@/types'
import {
    MessageCircle,
    Users,
    Tag,
    LayoutGrid,
    Send,
    Layers,
    Settings,
    LogOut,
    Menu,
    X,
    ChevronDown,
    Plus,
    UserPlus,
    History,
    Loader2,
} from 'lucide-react'

interface DashboardLayoutProps {
    children: React.ReactNode
}

const navigation = [
    { name: 'ダッシュボード', href: '/dashboard', icon: LayoutGrid },
    { name: '友だち管理', href: '/dashboard/friends', icon: Users },
    { name: '1:1チャット', href: '/dashboard/chats', icon: MessageCircle },
    { name: 'タグ管理', href: '/dashboard/tags', icon: Tag },
    { name: 'リッチメニュー', href: '/dashboard/rich-menus', icon: LayoutGrid },
    { name: 'メッセージ配信', href: '/dashboard/messages', icon: Send },
    { name: 'ステップ配信', href: '/dashboard/step', icon: Layers },
    { name: 'チーム', href: '/dashboard/team', icon: UserPlus },
    { name: '操作ログ', href: '/dashboard/logs', icon: History },
    { name: '設定', href: '/dashboard/settings', icon: Settings },
]

export default function DashboardLayout({ children }: DashboardLayoutProps) {
    const pathname = usePathname()
    const router = useRouter()
    const [sidebarOpen, setSidebarOpen] = useState(false)
    const [profile, setProfile] = useState<Profile | null>(null)
    const [channels, setChannels] = useState<Channel[]>([])
    const [currentChannel, setCurrentChannel] = useState<Channel | null>(null)
    const [channelMenuOpen, setChannelMenuOpen] = useState(false)

    // パスワード認証用
    const [authModalOpen, setAuthModalOpen] = useState(false)
    const [targetChannel, setTargetChannel] = useState<Channel | null>(null)
    const [password, setPassword] = useState('')
    const [authLoading, setAuthLoading] = useState(false)
    const [authError, setAuthError] = useState('')

    useEffect(() => {
        const fetchData = async () => {
            const supabase = createClient()

            // プロフィール取得
            const { data: { user } } = await supabase.auth.getUser()
            if (user) {
                const { data: profileData } = await supabase
                    .from('profiles')
                    .select('*')
                    .eq('id', user.id)
                    .single()
                setProfile(profileData)

                // チャンネル一覧取得
                const { data: memberships } = await supabase
                    .from('channel_members')
                    .select('channel_id, channels(*)')
                    .eq('profile_id', user.id)

                if (memberships) {
                    const channelList = memberships
                        .map(m => m.channels as unknown as Channel)
                        .filter(Boolean)
                    setChannels(channelList)

                    // Cookieから選択中のチャンネルIDを取得
                    const cookies = document.cookie.split('; ').reduce((acc, current) => {
                        const [key, value] = current.split('=')
                        acc[key] = value
                        return acc
                    }, {} as Record<string, string>)
                    const savedChannelId = cookies['line-manager-channel-id']

                    // チャンネル選択ロジック
                    if (channelList.length > 0) {
                        const targetChannel = channelList.find(c => c.id === savedChannelId) || channelList[0]
                        setCurrentChannel(targetChannel)

                        // Cookieに保存（未保存の場合のみ）
                        if (!savedChannelId || savedChannelId !== targetChannel.id) {
                            document.cookie = `line-manager-channel-id=${targetChannel.id}; path=/; max-age=31536000` // 1年有効
                        }
                    }
                }
            }
        }

        fetchData()
    }, [])

    const handleLogout = async () => {
        const supabase = createClient()
        await supabase.auth.signOut()
        document.cookie = 'line-manager-channel-id=; path=/; max-age=0' // Cookie削除
        router.push('/login')
        router.refresh()
    }

    const selectChannel = (channel: Channel) => {
        if (channel.id === currentChannel?.id) {
            setChannelMenuOpen(false)
            return
        }

        // パスワード保護チェック
        if (channel.access_password) {
            setTargetChannel(channel)
            setAuthModalOpen(true)
            setChannelMenuOpen(false)
            return
        }

        // パスワードなしの場合は即時切り替え
        performSwitch(channel)
    }

    const performSwitch = (channel: Channel) => {
        setCurrentChannel(channel)
        setChannelMenuOpen(false)
        document.cookie = `line-manager-channel-id=${channel.id}; path=/; max-age=31536000`
        window.location.reload()
    }

    const handleAuthSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!targetChannel || !password) return

        setAuthLoading(true)
        setAuthError('')

        try {
            const response = await fetch('/api/channels/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channelId: targetChannel.id,
                    password,
                }),
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || '認証に失敗しました')
            }

            // 認証成功
            setAuthModalOpen(false)
            setPassword('')
            performSwitch(targetChannel)

        } catch (error: any) {
            setAuthError('パスワードが正しくありません')
        } finally {
            setAuthLoading(false)
        }
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-slate-100 to-emerald-50 dark:from-slate-950 dark:via-slate-900 dark:to-emerald-950">
            {/* パスワード認証モーダル */}
            <Dialog open={authModalOpen} onOpenChange={setAuthModalOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>パスワード認証</DialogTitle>
                        <DialogDescription>
                            「{targetChannel?.name}」にアクセスするにはパスワードが必要です。
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleAuthSubmit}>
                        <div className="space-y-4 py-4">
                            <div className="space-y-2">
                                <Label htmlFor="password">アクセスパスワード</Label>
                                <Input
                                    id="password"
                                    type="password"
                                    placeholder="パスワードを入力..."
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    autoFocus
                                />
                                {authError && (
                                    <p className="text-sm text-red-500">{authError}</p>
                                )}
                            </div>
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setAuthModalOpen(false)}>
                                キャンセル
                            </Button>
                            <Button type="submit" disabled={authLoading || !password}>
                                {authLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                                ロック解除
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
            {/* モバイルサイドバーオーバーレイ */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 lg:hidden"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* サイドバー */}
            <aside
                className={cn(
                    "fixed top-0 left-0 z-50 h-full w-72 bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl border-r border-slate-200/50 dark:border-slate-700/50 transform transition-transform duration-300 lg:translate-x-0",
                    sidebarOpen ? "translate-x-0" : "-translate-x-full"
                )}
            >
                <div className="flex flex-col h-full">
                    {/* ロゴ */}
                    <div className="flex items-center gap-3 px-6 py-5 border-b border-slate-200/50 dark:border-slate-700/50">
                        <div className="w-10 h-10 bg-gradient-to-br from-emerald-500 to-green-600 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/30">
                            <MessageCircle className="w-5 h-5 text-white" />
                        </div>
                        <span className="text-lg font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                            LINE Manager
                        </span>
                        <button
                            className="ml-auto lg:hidden"
                            onClick={() => setSidebarOpen(false)}
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* チャンネル選択 */}
                    <div className="px-4 py-4 border-b border-slate-200/50 dark:border-slate-700/50">
                        <div className="relative">
                            <button
                                onClick={() => setChannelMenuOpen(!channelMenuOpen)}
                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200/80 dark:hover:bg-slate-700/80 transition-colors"
                            >
                                <div className="w-8 h-8 bg-gradient-to-br from-emerald-400 to-green-500 rounded-lg flex items-center justify-center text-white text-sm font-medium">
                                    {currentChannel?.name?.[0] || '?'}
                                </div>
                                <div className="flex-1 text-left">
                                    <p className="text-sm font-medium truncate">
                                        {currentChannel?.name || 'アカウント未選択'}
                                    </p>
                                    <p className="text-xs text-slate-500 dark:text-slate-400">
                                        {channels.length}個のアカウント
                                    </p>
                                </div>
                                <ChevronDown className={cn(
                                    "w-4 h-4 text-slate-400 transition-transform",
                                    channelMenuOpen && "rotate-180"
                                )} />
                            </button>

                            {/* チャンネルドロップダウン */}
                            {channelMenuOpen && (
                                <div className="absolute top-full left-0 right-0 mt-2 py-2 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200/50 dark:border-slate-700/50 z-10">
                                    {channels.map(channel => (
                                        <button
                                            key={channel.id}
                                            onClick={() => selectChannel(channel)}
                                            className={cn(
                                                "w-full flex items-center gap-3 px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors",
                                                currentChannel?.id === channel.id && "bg-emerald-50 dark:bg-emerald-900/20"
                                            )}
                                        >
                                            <div className="w-8 h-8 bg-gradient-to-br from-emerald-400 to-green-500 rounded-lg flex items-center justify-center text-white text-sm font-medium">
                                                {channel.name[0]}
                                            </div>
                                            <span className="text-sm truncate">{channel.name}</span>
                                        </button>
                                    ))}
                                    <Link
                                        href="/dashboard/channels/new"
                                        className="w-full flex items-center gap-3 px-3 py-2 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
                                    >
                                        <div className="w-8 h-8 border-2 border-dashed border-emerald-400 rounded-lg flex items-center justify-center">
                                            <Plus className="w-4 h-4" />
                                        </div>
                                        <span className="text-sm">アカウント追加</span>
                                    </Link>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* ナビゲーション */}
                    <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
                        {navigation.map(item => {
                            const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
                            return (
                                <Link
                                    key={item.name}
                                    href={item.href}
                                    className={cn(
                                        "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
                                        isActive
                                            ? "bg-gradient-to-r from-emerald-500 to-green-600 text-white shadow-lg shadow-emerald-500/30"
                                            : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                    )}
                                    onClick={() => setSidebarOpen(false)}
                                >
                                    <item.icon className="w-5 h-5" />
                                    {item.name}
                                </Link>
                            )
                        })}
                    </nav>

                    {/* ユーザーメニュー */}
                    <div className="px-4 py-4 border-t border-slate-200/50 dark:border-slate-700/50">
                        <div className="flex items-center gap-3 px-3 py-2">
                            <div className="w-10 h-10 bg-gradient-to-br from-slate-400 to-slate-500 rounded-full flex items-center justify-center text-white font-medium">
                                {profile?.display_name?.[0] || profile?.email?.[0] || '?'}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">
                                    {profile?.display_name || profile?.email}
                                </p>
                                <p className="text-xs text-slate-500 truncate">
                                    {profile?.email}
                                </p>
                            </div>
                            <button
                                onClick={handleLogout}
                                className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                                title="ログアウト"
                            >
                                <LogOut className="w-5 h-5" />
                            </button>
                        </div>
                    </div>
                </div>
            </aside>

            {/* メインコンテンツ */}
            <div className="lg:pl-72">
                {/* ヘッダー */}
                <header className="sticky top-0 z-30 flex items-center gap-4 px-4 py-3 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border-b border-slate-200/50 dark:border-slate-700/50 lg:px-8">
                    <button
                        onClick={() => setSidebarOpen(true)}
                        className="lg:hidden p-2 -ml-2 text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                    <div className="flex-1" />
                </header>

                {/* ページコンテンツ */}
                <main className="p-4 lg:p-8 pb-20 lg:pb-8">
                    {children}
                </main>
            </div>
        </div>
    )
}
