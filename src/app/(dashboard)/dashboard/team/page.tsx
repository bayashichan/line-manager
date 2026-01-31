'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui'
import { cn, formatDateTime, getCookie } from '@/lib/utils'
import type { Channel, ChannelMember, Profile } from '@/types'
import {
    Users,
    UserPlus,
    Mail,
    Shield,
    ShieldCheck,
    Trash2,
    Loader2,
    Copy,
    Check,
    AlertTriangle,
    Search,
} from 'lucide-react'

interface MemberWithProfile extends ChannelMember {
    profiles: Profile
}

export default function TeamPage() {
    const [channel, setChannel] = useState<Channel | null>(null)
    const [members, setMembers] = useState<MemberWithProfile[]>([])
    const [loading, setLoading] = useState(true)
    const [inviteEmail, setInviteEmail] = useState('')
    const [inviteRole, setInviteRole] = useState<'admin'>('admin')
    const [inviting, setInviting] = useState(false)
    const [inviteError, setInviteError] = useState('')
    const [inviteSuccess, setInviteSuccess] = useState('')
    const [currentUserId, setCurrentUserId] = useState<string | null>(null)

    useEffect(() => {
        fetchData()
    }, [])

    const fetchData = async () => {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) return
        setCurrentUserId(user.id)

        // CookieからチャンネルIDを取得
        const savedChannelId = getCookie('line-manager-channel-id')

        // チャンネル取得
        let query = supabase
            .from('channel_members')
            .select('channel_id, role, channels(*)')
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

        // メンバー一覧取得
        const { data: membersData } = await supabase
            .from('channel_members')
            .select(`
        *,
        profiles (*)
      `)
            .eq('channel_id', memberships[0].channel_id)
            .order('role')
            .order('created_at')

        if (membersData) {
            setMembers(membersData as MemberWithProfile[])
        }

        setLoading(false)
    }

    const handleInvite = async () => {
        if (!inviteEmail.trim() || !channel) return

        setInviting(true)
        setInviteError('')
        setInviteSuccess('')

        try {
            const response = await fetch('/api/team/invite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channelId: channel.id,
                    email: inviteEmail,
                    role: inviteRole,
                }),
            })

            const data = await response.json()

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error('ユーザーが見つかりません。相手に先にアカウント登録してもらう必要があります。')
                } else if (response.status === 409) {
                    throw new Error('このユーザーは既にメンバーです。')
                } else {
                    throw new Error(data.error || '招待に失敗しました')
                }
            }

            setInviteSuccess(`${inviteEmail} をメンバーに追加しました`)
            setInviteEmail('')

            // メンバー一覧を再取得
            await fetchData()

        } catch (error: any) {
            console.error('招待エラー:', error)
            setInviteError(error.message)
        }

        setInviting(false)
    }

    const handleRemoveMember = async (memberId: string) => {
        if (!confirm('このメンバーを削除しますか？')) return

        const supabase = createClient()
        await supabase.from('channel_members').delete().eq('id', memberId)
        await fetchData()
    }

    const handleChangeRole = async (memberId: string, newRole: 'owner' | 'admin') => {
        const supabase = createClient()
        await supabase
            .from('channel_members')
            .update({ role: newRole })
            .eq('id', memberId)
        await fetchData()
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
                <p className="text-slate-500">チャンネルが見つかりません</p>
            </div>
        )
    }

    const currentMember = members.find(m => m.profile_id === currentUserId)
    const isOwner = currentMember?.role === 'owner'

    return (
        <div className="space-y-6 max-w-3xl">
            {/* ヘッダー */}
            <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                    チーム管理
                </h1>
                <p className="text-slate-500 dark:text-slate-400 mt-1">
                    {channel.name}のメンバーを管理
                </p>
            </div>

            {/* 招待フォーム */}
            {isOwner && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <UserPlus className="w-5 h-5" />
                            メンバーを招待
                        </CardTitle>
                        <CardDescription>
                            メールアドレスで新しいメンバーを招待します
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex gap-4">
                            <div className="flex-1 space-y-2">
                                <Label>メールアドレス</Label>
                                <Input
                                    type="email"
                                    value={inviteEmail}
                                    onChange={(e) => setInviteEmail(e.target.value)}
                                    placeholder="example@email.com"
                                />
                            </div>
                            <div className="w-40 space-y-2">
                                <Label>権限</Label>
                                <select
                                    value={inviteRole}
                                    onChange={(e) => setInviteRole(e.target.value as 'admin')}
                                    className="w-full h-10 px-3 rounded-lg border border-slate-200 bg-white/50 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-800/50"
                                >
                                    <option value="admin">管理者</option>
                                </select>
                            </div>
                        </div>

                        <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
                            {inviting && <Loader2 className="w-4 h-4 animate-spin" />}
                            <UserPlus className="w-4 h-4" />
                            メンバーを追加
                        </Button>

                        {inviteSuccess && (
                            <div className="p-3 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 rounded-lg text-sm flex items-center gap-2">
                                <Check className="w-4 h-4" />
                                {inviteSuccess}
                            </div>
                        )}

                        {inviteError && (
                            <div className="p-3 bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 rounded-lg text-sm flex items-center gap-2">
                                <AlertTriangle className="w-4 h-4" />
                                {inviteError}
                            </div>
                        )}

                        <p className="text-xs text-slate-500">
                            ※ 追加したいメンバーは、あらかじめこのアプリにアカウント登録（サインアップ）している必要があります。
                        </p>
                    </CardContent>
                </Card>
            )}

            {/* メンバー一覧 */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Users className="w-5 h-5" />
                        メンバー一覧
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="space-y-3">
                        {members.map(member => (
                            <div
                                key={member.id}
                                className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800 rounded-xl"
                            >
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                                        <span className="text-lg font-medium text-slate-600">
                                            {(member.profiles?.display_name || member.profiles?.email || '?')?.[0]?.toUpperCase()}
                                        </span>
                                    </div>
                                    <div>
                                        <p className="font-medium">
                                            {member.profiles?.display_name || member.profiles?.email || 'Unknown User'}
                                        </p>
                                        <p className="text-sm text-slate-500">{member.profiles?.email}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className={cn(
                                        "flex items-center gap-1 px-3 py-1 rounded-full text-sm",
                                        member.role === 'owner'
                                            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                                            : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                                    )}>
                                        {member.role === 'owner' ? (
                                            <ShieldCheck className="w-4 h-4" />
                                        ) : (
                                            <Shield className="w-4 h-4" />
                                        )}
                                        {member.role === 'owner' ? 'オーナー' : '管理者'}
                                    </div>

                                    {isOwner && member.profile_id !== currentUserId && (
                                        <button
                                            onClick={() => handleRemoveMember(member.id)}
                                            className="p-2 hover:bg-red-50 text-red-500 rounded-lg transition-colors"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            {/* 注意事項 */}
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-800">
                <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5" />
                    <div>
                        <p className="font-medium text-amber-800 dark:text-amber-400">
                            権限について
                        </p>
                        <ul className="mt-2 text-sm text-amber-700 dark:text-amber-500 space-y-1">
                            <li><strong>オーナー:</strong> すべての操作が可能（メンバー管理、設定変更）</li>
                            <li><strong>管理者:</strong> 友だち管理、メッセージ配信、タグ管理が可能</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div >
    )
}
