'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui'
import { Loader2, Plus, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export default function NewChannelPage() {
    const router = useRouter()
    const [loading, setLoading] = useState(false)
    const [name, setName] = useState('')
    const [channelId, setChannelId] = useState('')
    const [channelSecret, setChannelSecret] = useState('')
    const [channelAccessToken, setChannelAccessToken] = useState('')

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!name || !channelId || !channelSecret || !channelAccessToken) return

        setLoading(true)
        const supabase = createClient()

        try {
            const { data: { user } } = await supabase.auth.getUser()
            if (!user) throw new Error('認証エラー')

            // チャンネル作成
            const { data: channel, error: channelError } = await supabase
                .from('channels')
                .insert({
                    name,
                    channel_id: channelId,
                    channel_secret: channelSecret,
                    channel_access_token: channelAccessToken,
                    created_by: user.id // 作成者を記録
                })
                .select()
                .single()

            if (channelError) throw channelError

            // メンバーシップ作成（オーナー権限）
            const { error: memberError } = await supabase
                .from('channel_members')
                .insert({
                    channel_id: channel.id,
                    profile_id: user.id,
                    role: 'owner'
                })

            if (memberError) throw memberError

            // Cookieに設定してダッシュボードへ
            document.cookie = `line-manager-channel-id=${channel.id}; path=/; max-age=31536000`

            // 少し待ってからリダイレクト（Cookie反映のため）
            setTimeout(() => {
                window.location.href = '/dashboard'
            }, 500)

        } catch (error: any) {
            console.error('作成エラー:', JSON.stringify(error, null, 2))
            alert(`チャンネルの作成に失敗しました:\n${error.message || JSON.stringify(error, null, 2)}`)
            setLoading(false)
        }
    }

    return (
        <div className="max-w-2xl mx-auto py-8">
            <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 mb-6 transition-colors"
            >
                <ArrowLeft className="w-4 h-4" />
                ダッシュボードに戻る
            </Link>

            <Card>
                <CardHeader>
                    <CardTitle className="text-2xl flex items-center gap-2">
                        <Plus className="w-6 h-6 text-emerald-500" />
                        新しいアカウントを追加
                    </CardTitle>
                    <CardDescription>
                        LINE Developersコンソールから取得した情報を入力してください
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="space-y-2">
                            <Label htmlFor="name">アカウント名（表示名）</Label>
                            <Input
                                id="name"
                                placeholder="例: 公式ストア サポート"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                required
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="channelId">Channel ID</Label>
                            <Input
                                id="channelId"
                                placeholder="1234567890"
                                value={channelId}
                                onChange={(e) => setChannelId(e.target.value)}
                                required
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="channelSecret">Channel Secret</Label>
                            <Input
                                id="channelSecret"
                                type="password"
                                placeholder="••••••••••••••••"
                                value={channelSecret}
                                onChange={(e) => setChannelSecret(e.target.value)}
                                required
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="accessToken">Channel Access Token</Label>
                            <Input
                                id="accessToken"
                                type="password"
                                placeholder="長いアクセストークンを入力..."
                                value={channelAccessToken}
                                onChange={(e) => setChannelAccessToken(e.target.value)}
                                required
                            />
                        </div>

                        <div className="pt-4 flex justify-end">
                            <Button
                                type="submit"
                                disabled={loading}
                                className="bg-emerald-500 hover:bg-emerald-600 w-full sm:w-auto"
                            >
                                {loading ? (
                                    <>
                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                        作成中...
                                    </>
                                ) : (
                                    <>
                                        アカウントを作成
                                    </>
                                )}
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>
        </div>
    )
}
