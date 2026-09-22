'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui'
import { useToast } from '@/hooks/use-toast'
import type { Channel, Tag } from '@/types'
import {
    Settings,
    Key,
    Link2,
    Save,
    Loader2,
    Copy,
    Check,
    ExternalLink,
    Tag as TagIcon,
    Lock,
    Eye,
    EyeOff,
    CloudLightning, // Added
    UploadCloud,
} from 'lucide-react'
import { cn, getCookie } from '@/lib/utils'

export default function SettingsPage() {
    const { toast } = useToast() // Added
    const [channel, setChannel] = useState<Channel | null>(null)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [copied, setCopied] = useState(false)

    // フォーム
    const [formName, setFormName] = useState('')
    const [formChannelId, setFormChannelId] = useState('')
    const [formChannelSecret, setFormChannelSecret] = useState('')
    const [formChannelAccessToken, setFormChannelAccessToken] = useState('')
    const [formLMessageWebhookUrl, setFormLMessageWebhookUrl] = useState('')
    const [formAutoReplyTags, setFormAutoReplyTags] = useState<string[]>([])

    // パスワード設定用
    const [formPassword, setFormPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [hasPassword, setHasPassword] = useState(false)
    const [passwordSaving, setPasswordSaving] = useState(false)

    // タグ一覧
    const [tags, setTags] = useState<Tag[]>([])

    useEffect(() => {
        fetchData()
    }, [])

    const fetchData = async () => {
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

        if (memberships && memberships.length > 0) {
            const ch = memberships[0].channels as unknown as Channel
            setChannel(ch)
            setFormName(ch.name)
            setFormChannelId(ch.channel_id)
            setFormChannelSecret(ch.channel_secret)
            setFormChannelAccessToken(ch.channel_access_token)
            setFormLMessageWebhookUrl(ch.lmessage_webhook_url || '')
            setFormAutoReplyTags(ch.auto_reply_tags || [])
            setHasPassword(!!ch.access_password)

            // タグ一覧取得
            const { data: tagsData } = await supabase
                .from('tags')
                .select('*')
                .eq('channel_id', ch.id)
                .order('name')

            if (tagsData) {
                setTags(tagsData)
            }
        }

        setLoading(false)
    }

    const handleSave = async () => {
        if (!channel) return

        setSaving(true)
        const supabase = createClient()

        await supabase
            .from('channels')
            .update({
                name: formName,
                channel_id: formChannelId,
                channel_secret: formChannelSecret,
                channel_access_token: formChannelAccessToken,
                lmessage_webhook_url: formLMessageWebhookUrl || null,
                auto_reply_tags: formAutoReplyTags,
            })
            .eq('id', channel.id)

        setSaving(false)
        setSaving(false)
        alert('保存しました')
    }

    const handleSavePassword = async () => {
        if (!channel) return

        setPasswordSaving(true)

        try {
            const response = await fetch('/api/channels/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channelId: channel.id,
                    password: formPassword || null // 空文字なら解除
                }),
            })

            if (!response.ok) {
                const error = await response.json()
                throw new Error(error.message || '設定に失敗しました')
            }

            setHasPassword(!!formPassword)
            setFormPassword('')
            alert(formPassword ? 'アクセスパスワードを設定しました' : 'アクセスパスワードを解除しました')

        } catch (error: any) {
            console.error(error)
            alert(error.message)
        }

        setPasswordSaving(false)
    }

    const copyWebhookUrl = () => {
        const url = `${window.location.origin}/api/webhook/${formChannelId}`
        navigator.clipboard.writeText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    // DB修復機能
    const [isFixing, setIsFixing] = useState(false)
    const [isMigrating, setIsMigrating] = useState(false)
    const [migrateLog, setMigrateLog] = useState<string[]>([])
    const [isLockingDown, setIsLockingDown] = useState(false)

    const handleFixDatabase = async () => {
        if (!confirm('データベースの接続設定と権限を修復しますか？\n（チャット受信などがうまくいかない場合に実行してください）')) return

        setIsFixing(true)
        try {
            const res = await fetch('/api/admin/fix-realtime', {
                method: 'POST',
            })

            const data = await res.json()

            if (!res.ok) {
                throw new Error(data.error || '修復に失敗しました')
            }

            toast({
                title: "修復完了",
                description: "データベースの設定を修正しました。画面をリロードして動作を確認してください。",
            })
        } catch (error: any) {
            toast({
                title: "エラー",
                description: error.message,
                variant: "destructive",
            })
        } finally {
            setIsFixing(false)
        }
    }

    // 過去にSupabase Storageへ上げた画像・動画をR2へ移す。
    // 複製はVercelの実行時間に収まるよう小分けにして、残りが0になるまで繰り返す
    const callMigrate = async (body: Record<string, unknown>) => {
        const res = await fetch('/api/admin/migrate-storage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || '移行に失敗しました')
        return data
    }

    const handleMigrateStorage = async () => {
        if (!confirm('過去にアップロードした画像・動画をR2へ移し、保存済みのURLを書き換えます。\n何度実行しても問題ありません。実行しますか？')) return

        setIsMigrating(true)
        setMigrateLog([])
        const log = (line: string) => setMigrateLog(prev => [...prev, line])

        try {
            let copied = 0

            for (let i = 0; i < 100; i++) {
                const result = await callMigrate({ limit: 50 })
                copied += result.copied

                if (result.failed?.length) {
                    log(`※ ${result.failed.length}件は複製できませんでした`)
                }

                if (result.remaining === 0) {
                    log(`ファイルの複製が完了しました（新規 ${copied}件 / 複製済み ${result.alreadyCopied}件）`)
                    break
                }

                // 1件も進まないなら繰り返しても意味がないので止める
                if (result.copied === 0) {
                    log(`残り ${result.remaining}件を複製できませんでした。時間をおいて再実行してください`)
                    break
                }

                log(`複製中… ${copied}件完了 / 残り ${result.remaining}件`)
            }

            log('保存済みのURLを書き換えています…')
            const rewrite = await callMigrate({ step: 'rewrite' })
            const rewritten = Object.values(rewrite.report || {})
                .filter((v): v is number => typeof v === 'number')
                .reduce((a, b) => a + b, 0)
            log(`完了しました（URL ${rewritten}件を書き換え）`)

            toast({
                title: '移行完了',
                description: 'リッチメニューやチャット履歴で画像が表示されるか確認してください。',
            })
        } catch (error: any) {
            log(`エラー: ${error.message}`)
            toast({
                title: 'エラー',
                description: error.message,
                variant: 'destructive',
            })
        } finally {
            setIsMigrating(false)
        }
    }

    // 移行と表示確認が済んだあと、旧保存先を非公開にして転送量の発生を止める
    const handleLockdownStorage = async () => {
        if (!confirm('旧い保存先を非公開にします。\n\n必ず先に「移行を実行する」を終えて、画像が表示されることを確認してください。\n確認前に実行すると画像が表示されなくなります。\n\n実行しますか？')) return

        setIsLockingDown(true)
        try {
            const result = await callMigrate({ step: 'lockdown' })
            setMigrateLog(prev => [...prev, result.message])
            toast({
                title: '完了',
                description: '旧い保存先を非公開にしました。通信量の超過は起きなくなります。',
            })
        } catch (error: any) {
            setMigrateLog(prev => [...prev, `エラー: ${error.message}`])
            toast({
                title: 'エラー',
                description: error.message,
                variant: 'destructive',
            })
        } finally {
            setIsLockingDown(false)
        }
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
                <p className="text-slate-500">
                    チャンネルが見つかりません
                </p>
            </div>
        )
    }

    return (
        <div className="space-y-6 max-w-2xl">
            {/* ヘッダー */}
            <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                    設定
                </h1>
                <p className="text-slate-500 dark:text-slate-400 mt-1">
                    LINE公式アカウントの設定を管理
                </p>
            </div>

            {/* 基本設定 */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Settings className="w-5 h-5" />
                        基本設定
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label>アカウント名（管理用）</Label>
                        <Input
                            value={formName}
                            onChange={(e) => setFormName(e.target.value)}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label>Channel ID</Label>
                        <Input
                            value={formChannelId}
                            onChange={(e) => setFormChannelId(e.target.value)}
                        />
                    </div>
                </CardContent>
            </Card>

            {/* 自動タグ付け設定 */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <TagIcon className="w-5 h-5" />
                        友だち追加時の自動タグ付け
                    </CardTitle>
                    <CardDescription>
                        新規友だち追加（またはブロック解除）された際に、自動的に付与するタグを選択してください
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-wrap gap-2">
                        {tags.map(tag => {
                            const isSelected = formAutoReplyTags.includes(tag.id)
                            return (
                                <button
                                    key={tag.id}
                                    onClick={() => {
                                        if (isSelected) {
                                            setFormAutoReplyTags(prev => prev.filter(id => id !== tag.id))
                                        } else {
                                            setFormAutoReplyTags(prev => [...prev, tag.id])
                                        }
                                    }}
                                    className={cn(
                                        "px-3 py-1.5 rounded-full text-sm font-medium transition-all duration-200 border",
                                        isSelected
                                            ? "border-transparent text-white shadow-md transform scale-105"
                                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                                    )}
                                    style={isSelected ? { backgroundColor: tag.color } : {}}
                                >
                                    {isSelected && <Check className="w-3 h-3 inline mr-1" />}
                                    {tag.name}
                                </button>
                            )
                        })}
                        {tags.length === 0 && (
                            <p className="text-sm text-slate-500">
                                タグがまだありません。タグ管理画面で作成してください。
                            </p>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* セキュリティ設定 */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Lock className="w-5 h-5" />
                        セキュリティ設定
                    </CardTitle>
                    <CardDescription>
                        チャンネル切り替え時のアクセス制限設定
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800 rounded-lg">
                        <div>
                            <p className="font-medium">現在のステータス</p>
                            <p className={cn("text-sm mt-1", hasPassword ? "text-emerald-600" : "text-slate-500")}>
                                {hasPassword ? '🔒 パスワード保護されています' : '🔓 現在パスワードは設定されていません'}
                            </p>
                        </div>
                        {hasPassword && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="text-red-500 hover:text-red-600 hover:bg-red-50"
                                onClick={() => {
                                    if (confirm('パスワードを解除してもよろしいですか？')) {
                                        setFormPassword('')
                                        handleSavePassword()
                                    }
                                }}
                            >
                                設定解除
                            </Button>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label>
                            {hasPassword ? 'パスワードを変更' : '新しいパスワードを設定'}
                        </Label>
                        <div className="flex gap-2">
                            <div className="relative flex-1">
                                <Input
                                    type={showPassword ? "text" : "password"}
                                    value={formPassword}
                                    onChange={(e) => setFormPassword(e.target.value)}
                                    placeholder="パスワードを入力..."
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                                >
                                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                            <Button
                                onClick={handleSavePassword}
                                disabled={passwordSaving || !formPassword}
                            >
                                {passwordSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                {hasPassword ? '変更' : '設定'}
                            </Button>
                        </div>
                        <p className="text-xs text-slate-500">
                            設定すると、他のユーザー（または自分）がこのチャンネルに切り替える際にパスワードが必要になります。
                        </p>
                    </div>
                </CardContent>
            </Card>

            {/* 認証情報 */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Key className="w-5 h-5" />
                        認証情報
                    </CardTitle>
                    <CardDescription>
                        LINE Developersコンソールから取得した情報
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label>Channel Secret</Label>
                        <Input
                            type="password"
                            value={formChannelSecret}
                            onChange={(e) => setFormChannelSecret(e.target.value)}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label>Channel Access Token</Label>
                        <Input
                            type="password"
                            value={formChannelAccessToken}
                            onChange={(e) => setFormChannelAccessToken(e.target.value)}
                        />
                    </div>
                </CardContent>
            </Card>

            {/* Webhook URL */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Link2 className="w-5 h-5" />
                        Webhook URL
                    </CardTitle>
                    <CardDescription>
                        LINE DevelopersのMessaging API設定に以下のURLを登録してください
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center gap-2">
                        <code className="flex-1 p-3 bg-slate-100 dark:bg-slate-800 rounded-lg text-sm break-all">
                            {typeof window !== 'undefined' && `${window.location.origin}/api/webhook/${formChannelId}`}
                        </code>
                        <Button variant="outline" size="icon" onClick={copyWebhookUrl}>
                            {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                        </Button>
                    </div>
                    <a
                        href="https://developers.line.biz/console/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-emerald-600 hover:underline"
                    >
                        LINE Developersコンソールを開く
                        <ExternalLink className="w-3 h-3" />
                    </a>
                </CardContent>
            </Card>

            {/* Webhook転送設定 (LMessage連携) */}
            <Card className="border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-900/10">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                        <Link2 className="w-5 h-5" />
                        Webhook転送設定 (LMessage併用)
                    </CardTitle>
                    <CardDescription>
                        LMessageなどの外部ツールと併用する場合、そのツールのWebhook URLをここに入力してください。<br />
                        LINEからの通知をこのアプリで受信した後、指定されたURLへ転送します。
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label>転送先 Webhook URL</Label>
                        <Input
                            value={formLMessageWebhookUrl}
                            onChange={(e) => setFormLMessageWebhookUrl(e.target.value)}
                            placeholder="https://lmes.jp/api/webhook/..."
                        />
                        <p className="text-xs text-slate-500">
                            ※ここに入力すると、LINE DevelopersにはこのアプリのWebhook URLを設定したまま、LMessageも正常に動作します。
                        </p>
                    </div>
                </CardContent>
            </Card>

            {/* システム修復設定 */}
            <Card className="border-yellow-200 dark:border-yellow-900 bg-yellow-50/50 dark:bg-yellow-900/10">
                <CardHeader>
                    <div className="flex items-center gap-2">
                        <CloudLightning className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />
                        <CardTitle>トラブルシューティング</CardTitle>
                    </div>
                    <CardDescription>
                        チャットの受信やバッジ表示がうまくいかない場合に実行してください。
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Button
                        onClick={handleFixDatabase}
                        disabled={isFixing}
                        variant="outline"
                        className="w-full sm:w-auto border-yellow-200 hover:bg-yellow-100 hover:text-yellow-900"
                    >
                        {isFixing ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                修復中...
                            </>
                        ) : (
                            <>
                                <CloudLightning className="mr-2 h-4 w-4" />
                                データベース接続・権限を修復する
                            </>
                        )}
                    </Button>
                </CardContent>
            </Card>

            {/* ストレージ移行 */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <UploadCloud className="w-5 h-5" />
                        画像・動画の保存先を移行
                    </CardTitle>
                    <CardDescription>
                        過去にアップロードした画像・動画を、転送量のかからない配信元へ移します。
                        LINEへの配信で通信量を使い切ってサービスが止まるのを防ぐための作業です。
                        何度実行しても問題ありません。
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex flex-col sm:flex-row gap-2">
                        <Button
                            onClick={handleMigrateStorage}
                            disabled={isMigrating || isLockingDown}
                            variant="outline"
                            className="w-full sm:w-auto"
                        >
                            {isMigrating ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    移行中...
                                </>
                            ) : (
                                <>
                                    <UploadCloud className="mr-2 h-4 w-4" />
                                    1. 移行を実行する
                                </>
                            )}
                        </Button>

                        <Button
                            onClick={handleLockdownStorage}
                            disabled={isMigrating || isLockingDown}
                            variant="outline"
                            className="w-full sm:w-auto border-yellow-200 hover:bg-yellow-100 hover:text-yellow-900"
                        >
                            {isLockingDown ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    処理中...
                                </>
                            ) : (
                                <>
                                    <Lock className="mr-2 h-4 w-4" />
                                    2. 旧い保存先を閉じる
                                </>
                            )}
                        </Button>
                    </div>

                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        1 を実行したあと、リッチメニューやチャット履歴で画像が表示されることを確認してから 2 を実行してください。
                    </p>

                    {migrateLog.length > 0 && (
                        <div className="rounded-md bg-slate-50 dark:bg-slate-900 p-3 space-y-1 text-sm text-slate-600 dark:text-slate-300">
                            {migrateLog.map((line, i) => (
                                <p key={i}>{line}</p>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* 保存ボタン */}
            <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving}>
                    {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                    <Save className="w-4 h-4" />
                    設定を保存
                </Button>
            </div>
        </div>
    )
}
