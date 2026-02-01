'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { cn, formatDateTime, getCookie } from '@/lib/utils'
import type { Message, Tag, StepScenario } from '@/types'
import {
    Send,
    Clock,
    CheckCircle,
    XCircle,
    AlertCircle,
    Plus,
    Tag as TagIcon,
    Loader2,
    X,
    Image as ImageIcon,
    Video,
    Type,
    Calendar,
    Upload,
    Trash2,
    Settings,
    Link,
    MessageSquare,
    Play
} from 'lucide-react'

type MessageType = 'text' | 'image' | 'video'

interface MessageBlock {
    type: MessageType
    text?: string
    imageUrl?: string
    videoUrl?: string
    previewUrl?: string
    linkUrl?: string // リッチメッセージ用 (旧)
    width?: number // アスペクト比計算用
    height?: number
    imageType?: 'normal' | 'rich' // 画像タイプ
    customActions?: {
        tagIds?: string[]
        scenarioId?: string
        replyText?: string
        redirectUrl?: string
    }
}

interface User {
    id: string
    line_user_id: string
    display_name: string
    picture_url?: string
}

const MAX_BLOCKS = 5
const MAX_TEXT_LENGTH = 5000

export default function MessagesPage() {
    const [messages, setMessages] = useState<Message[]>([])
    const [tags, setTags] = useState<Tag[]>([])
    const [scenarios, setScenarios] = useState<StepScenario[]>([])
    const [friendsCount, setFriendsCount] = useState(0)
    const [loading, setLoading] = useState(true)
    const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)
    const [testUsers, setTestUsers] = useState<User[]>([])
    const [isTestSending, setIsTestSending] = useState(false)
    const [showTestModal, setShowTestModal] = useState(false)
    const [isCreating, setIsCreating] = useState(false)
    const [sending, setSending] = useState(false)

    // フォーム
    const [formTitle, setFormTitle] = useState('')
    const [formBlocks, setFormBlocks] = useState<MessageBlock[]>([{ type: 'text', text: '' }])
    const [formSelectedTags, setFormSelectedTags] = useState<string[]>([])
    const [formScheduled, setFormScheduled] = useState(false)
    const [formScheduledAt, setFormScheduledAt] = useState('')

    const [newTagName, setNewTagName] = useState('')
    const [isCreatingTag, setIsCreatingTag] = useState(false)

    const [uploadingIndex, setUploadingIndex] = useState<number | null>(null)

    useEffect(() => {
        fetchChannelAndData()
    }, [])

    const fetchChannelAndData = async () => {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) return

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

        if (memberships && memberships.length > 0) {
            const channelId = memberships[0].channel_id
            setCurrentChannelId(channelId)
            await fetchData(channelId)
        }

        setLoading(false)
    }

    const fetchData = async (channelId: string) => {
        const supabase = createClient()

        const { data: messagesData } = await supabase
            .from('messages')
            .select('*')
            .eq('channel_id', channelId)
            .order('created_at', { ascending: false })
            .limit(50)

        if (messagesData) {
            setMessages(messagesData)
        }

        const { data: tagsData } = await supabase
            .from('tags')
            .select('*')
            .eq('channel_id', channelId)

        if (tagsData) {
            setTags(tagsData)
        }

        const { data: scenariosData } = await supabase
            .from('step_scenarios')
            .select('*')
            .eq('channel_id', channelId)
            .eq('is_active', true)

        if (scenariosData) {
            setScenarios(scenariosData)
        }

        const { count } = await supabase
            .from('line_users')
            .select('*', { count: 'exact', head: true })
            .eq('channel_id', channelId)
            .eq('is_blocked', false)

        setFriendsCount(count || 0)

        const { data: usersData } = await supabase
            .from('line_users')
            .select('id, line_user_id, display_name, picture_url')
            .eq('channel_id', channelId)
            .eq('is_blocked', false)
            .limit(20) // テスト配信用に上位20名のみ取得

        if (usersData) {
            setTestUsers(usersData)
        }
    }

    const resetForm = () => {
        setFormTitle('')
        setFormBlocks([{ type: 'text', text: '' }])
        setFormSelectedTags([])
        setFormScheduled(false)
        setFormScheduledAt('')
        setIsCreating(false)
    }

    const toggleTag = (tagId: string) => {
        setFormSelectedTags(prev =>
            prev.includes(tagId)
                ? prev.filter(id => id !== tagId)
                : [...prev, tagId]
        )
    }

    const handleCreateTag = async () => {
        if (!newTagName.trim() || !currentChannelId) return

        const supabase = createClient()
        const { data, error } = await supabase.from('tags').insert({
            channel_id: currentChannelId,
            name: newTagName,
            color: '#3B82F6', // Default color
            priority: 0
        }).select().single()

        if (data) {
            setTags([...tags, data])
            setNewTagName('')
            setIsCreatingTag(false)
        } else {
            console.error('タグ作成エラー:', error)
            alert('タグの作成に失敗しました')
        }
    }

    const addBlock = (type: MessageType) => {
        setFormBlocks([...formBlocks, { type }])
    }

    const updateBlock = (index: number, updates: Partial<MessageBlock>) => {
        const updated = [...formBlocks]
        updated[index] = { ...updated[index], ...updates }
        setFormBlocks(updated)
    }

    const removeBlock = (index: number) => {
        if (formBlocks.length === 1) return
        setFormBlocks(formBlocks.filter((_, i) => i !== index))
    }

    const getImageDimensions = (url: string): Promise<{ width: number; height: number }> => {
        return new Promise((resolve) => {
            const img = new Image()
            img.onload = () => resolve({ width: img.width, height: img.height })
            img.onerror = () => resolve({ width: 0, height: 0 })
            img.src = url
        })
    }

    const handleFileUpload = async (index: number, file: File, type: 'image' | 'video') => {
        if (!currentChannelId) return

        setUploadingIndex(index)
        const supabase = createClient()

        try {
            const fileExt = file.name.split('.').pop()
            const fileName = `${Date.now()}.${fileExt}`
            const folder = type === 'image' ? 'images' : 'videos'
            const filePath = `messages/${currentChannelId}/${folder}/${fileName}`

            const { error: uploadError } = await supabase.storage
                .from('line-assets')
                .upload(filePath, file)

            if (uploadError) throw uploadError

            const { data: { publicUrl } } = supabase.storage
                .from('line-assets')
                .getPublicUrl(filePath)

            if (type === 'image') {
                const { width, height } = await getImageDimensions(publicUrl)
                updateBlock(index, { imageUrl: publicUrl, width, height })
            } else {
                updateBlock(index, { videoUrl: publicUrl })
            }
        } catch (error) {
            console.error('アップロードエラー:', error)
            alert('アップロードに失敗しました')
        }

        setUploadingIndex(null)
    }

    const buildMessageContent = () => {
        return formBlocks.map(block => {
            switch (block.type) {
                case 'text':
                    return { type: 'text', text: block.text || '' }
                case 'image':
                    return {
                        type: 'image',
                        originalContentUrl: block.imageUrl,
                        previewImageUrl: block.imageUrl,
                        // linkUrlは廃止し、customActions.redirectUrlに統合するか、互換性のために残す
                        // ここではcustomActionsを優先使用
                        customActions: block.customActions ? {
                            tagIds: block.customActions.tagIds?.length ? block.customActions.tagIds : undefined,
                            scenarioId: block.customActions.scenarioId,
                            replyText: block.customActions.replyText,
                            redirectUrl: block.customActions.redirectUrl
                        } : undefined,
                        aspectRatio: block.width && block.height ? block.width / block.height : undefined,
                    }
                case 'video':
                    return {
                        type: 'video',
                        originalContentUrl: block.videoUrl,
                        previewImageUrl: block.previewUrl || block.videoUrl,
                    }
                default:
                    return null
            }
        }).filter(Boolean)
    }

    const isFormValid = () => {
        return formBlocks.every(block => {
            switch (block.type) {
                case 'text':
                    return block.text && block.text.trim().length > 0 && block.text.length <= MAX_TEXT_LENGTH
                case 'image':
                    return block.imageUrl
                case 'video':
                    return block.videoUrl
                default:
                    return false
            }
        })
    }

    const handleSend = async () => {
        if (!isFormValid() || !currentChannelId) return

        setSending(true)
        const supabase = createClient()

        try {
            const content = buildMessageContent()
            const status = formScheduled ? 'scheduled' : 'sending'
            const scheduledAt = formScheduled && formScheduledAt
                ? new Date(formScheduledAt).toISOString()
                : null

            const { data: message, error } = await supabase
                .from('messages')
                .insert({
                    channel_id: currentChannelId,
                    title: formTitle || '無題の配信',
                    content,
                    status,
                    filter_tags: formSelectedTags.length > 0 ? formSelectedTags : null,
                    scheduled_at: scheduledAt,
                })
                .select()
                .single()

            if (error) throw error

            // 即時配信の場合のみ送信
            if (!formScheduled) {
                const response = await fetch('/api/messages/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messageId: message.id }),
                })

                if (!response.ok) {
                    throw new Error('送信に失敗しました')
                }
            }

            await fetchData(currentChannelId)
            resetForm()
        } catch (error) {
            console.error('送信エラー:', error)
            alert('送信に失敗しました')
        }

        setSending(false)
    }

    const handleTestSend = async (userId: string) => {
        if (!isFormValid() || !currentChannelId) return

        if (!confirm('テスト送信を行いますか？')) return

        setIsTestSending(true)
        try {
            const content = buildMessageContent()
            const response = await fetch('/api/messages/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channelId: currentChannelId,
                    userId,
                    content
                }),
            })

            if (!response.ok) throw new Error('Failed to send test message')
            alert('テスト送信が完了しました')
            setShowTestModal(false)
        } catch (error) {
            console.error('Test send error:', error)
            alert('テスト送信に失敗しました')
        }
        setIsTestSending(false)
    }

    const getStatusIcon = (status: Message['status']) => {
        switch (status) {
            case 'sent':
                return <CheckCircle className="w-4 h-4 text-emerald-500" />
            case 'failed':
                return <XCircle className="w-4 h-4 text-red-500" />
            case 'sending':
                return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
            case 'scheduled':
                return <Clock className="w-4 h-4 text-amber-500" />
            default:
                return <AlertCircle className="w-4 h-4 text-slate-400" />
        }
    }

    const getStatusText = (status: Message['status']) => {
        switch (status) {
            case 'sent': return '配信完了'
            case 'failed': return '配信失敗'
            case 'sending': return '配信中'
            case 'scheduled': return '予約中'
            default: return '下書き'
        }
    }

    const getMessagePreview = (content: any[]) => {
        if (!content || content.length === 0) return '（内容なし）'

        const firstBlock = content[0]
        switch (firstBlock.type) {
            case 'text':
                return firstBlock.text
            case 'image':
                return '📷 画像'
            case 'video':
                return '🎬 動画'
            default:
                return '（不明）'
        }
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
                        メッセージ配信
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        配信対象: {friendsCount}人
                    </p>
                </div>
                <Button onClick={() => setIsCreating(true)}>
                    <Plus className="w-4 h-4" />
                    新規配信
                </Button>
            </div>

            {/* 作成フォーム */}
            {isCreating && (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>新規メッセージ配信</CardTitle>
                        <button onClick={resetForm} className="p-2 hover:bg-slate-100 rounded-lg">
                            <X className="w-5 h-5" />
                        </button>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label>配信タイトル（管理用）</Label>
                            <Input
                                value={formTitle}
                                onChange={(e) => setFormTitle(e.target.value)}
                                placeholder="例: 1月のキャンペーン告知"
                            />
                        </div>

                        {/* メッセージブロック */}
                        <div className="space-y-3">
                            <Label>メッセージ内容</Label>

                            {formBlocks.map((block, index) => (
                                <div key={index} className="p-3 sm:p-4 bg-slate-50 dark:bg-slate-800 rounded-xl space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            {block.type === 'text' && <Type className="w-4 h-4 text-blue-500" />}
                                            {block.type === 'image' && <ImageIcon className="w-4 h-4 text-green-500" />}
                                            {block.type === 'video' && <Video className="w-4 h-4 text-purple-500" />}
                                            <span className="text-sm font-medium">
                                                {block.type === 'text' && 'テキスト'}
                                                {block.type === 'image' && '画像'}
                                                {block.type === 'video' && '動画'}
                                            </span>
                                        </div>
                                        {formBlocks.length > 1 && (
                                            <button
                                                onClick={() => removeBlock(index)}
                                                className="p-1 text-red-500 hover:bg-red-50 rounded"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>

                                    {block.type === 'text' && (
                                        <>
                                            <textarea
                                                value={block.text || ''}
                                                onChange={(e) => updateBlock(index, { text: e.target.value })}
                                                placeholder="メッセージを入力..."
                                                className={cn(
                                                    "w-full h-32 px-3 py-2 rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:bg-slate-900 resize-none",
                                                    (block.text?.length || 0) > MAX_TEXT_LENGTH
                                                        ? "border-red-500 focus:ring-red-500"
                                                        : "border-slate-200 dark:border-slate-700"
                                                )}
                                            />
                                            <div className="text-right text-xs mt-1">
                                                <span className={cn(
                                                    (block.text?.length || 0) > MAX_TEXT_LENGTH ? "text-red-500 font-bold" : "text-slate-400"
                                                )}>
                                                    {block.text?.length || 0}
                                                </span>
                                                <span className="text-slate-400"> / {MAX_TEXT_LENGTH}文字</span>
                                            </div>
                                        </>
                                    )}

                                    {block.type === 'image' && (
                                        <div className="space-y-3">
                                            {block.imageUrl ? (
                                                <div className="space-y-3">
                                                    <div className="relative">
                                                        <img
                                                            src={block.imageUrl}
                                                            alt="プレビュー"
                                                            className="max-h-48 rounded-lg object-contain bg-slate-100"
                                                        />
                                                        <button
                                                            onClick={() => updateBlock(index, { imageUrl: undefined, linkUrl: undefined, customActions: undefined })}
                                                            className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded-full"
                                                        >
                                                            <X className="w-4 h-4" />
                                                        </button>
                                                    </div>

                                                    <div className="space-y-4 pt-2 border-t border-slate-100 dark:border-slate-700">
                                                        {/* 画像タイプ選択 */}
                                                        <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-lg">
                                                            <button
                                                                onClick={() => updateBlock(index, { imageType: 'normal' })}
                                                                className={cn(
                                                                    "flex-1 py-1.5 text-xs font-medium rounded-md transition-all",
                                                                    (!block.imageType || block.imageType === 'normal')
                                                                        ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm"
                                                                        : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                                                                )}
                                                            >
                                                                通常画像
                                                            </button>
                                                            <button
                                                                onClick={() => updateBlock(index, { imageType: 'rich' })}
                                                                className={cn(
                                                                    "flex-1 py-1.5 text-xs font-medium rounded-md transition-all",
                                                                    block.imageType === 'rich'
                                                                        ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm"
                                                                        : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                                                                )}
                                                            >
                                                                リッチメッセージ（アクション付き）
                                                            </button>
                                                        </div>

                                                        {block.imageType === 'rich' && (
                                                            <>
                                                                <Label className="text-sm font-medium flex items-center gap-2">
                                                                    <Settings className="w-4 h-4" />
                                                                    アクション設定（画像をタップした時の動作）
                                                                </Label>

                                                                {/* アクション設定グリッド */}
                                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                                    {/* タグ付け */}
                                                                    <div className="space-y-2">
                                                                        <Label className="text-xs text-slate-500 flex items-center gap-1">
                                                                            <TagIcon className="w-3 h-3" />
                                                                            タグを付与
                                                                        </Label>
                                                                        <div className="flex flex-wrap gap-2 p-2 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700">
                                                                            {tags.map(tag => (
                                                                                <button
                                                                                    key={tag.id}
                                                                                    onClick={() => {
                                                                                        const currentIds = block.customActions?.tagIds || []
                                                                                        const newIds = currentIds.includes(tag.id)
                                                                                            ? currentIds.filter(id => id !== tag.id)
                                                                                            : [...currentIds, tag.id]

                                                                                        const updatedActions = {
                                                                                            ...block.customActions,
                                                                                            tagIds: newIds
                                                                                        }
                                                                                        updateBlock(index, { customActions: updatedActions })
                                                                                    }}
                                                                                    className={cn(
                                                                                        "px-2 py-1 rounded-full text-xs font-medium transition-colors",
                                                                                        (block.customActions?.tagIds || []).includes(tag.id)
                                                                                            ? "text-white"
                                                                                            : "bg-white dark:bg-slate-800 text-slate-600 border border-slate-200"
                                                                                    )}
                                                                                    style={(block.customActions?.tagIds || []).includes(tag.id) ? { backgroundColor: tag.color } : {}}
                                                                                >
                                                                                    {tag.name}
                                                                                </button>
                                                                            ))}
                                                                            {tags.length === 0 && <span className="text-xs text-slate-400">タグがありません</span>}

                                                                            {isCreatingTag ? (
                                                                                <div className="flex items-center gap-1">
                                                                                    <Input
                                                                                        value={newTagName}
                                                                                        onChange={(e) => setNewTagName(e.target.value)}
                                                                                        placeholder="タグ名"
                                                                                        className="h-6 w-24 text-xs px-1"
                                                                                        autoFocus
                                                                                    />
                                                                                    <button onClick={handleCreateTag} className="text-emerald-500 hover:bg-emerald-50 p-0.5 rounded">
                                                                                        <CheckCircle className="w-4 h-4" />
                                                                                    </button>
                                                                                    <button onClick={() => setIsCreatingTag(false)} className="text-slate-400 hover:bg-slate-100 p-0.5 rounded">
                                                                                        <X className="w-4 h-4" />
                                                                                    </button>
                                                                                </div>
                                                                            ) : (
                                                                                <button
                                                                                    onClick={() => setIsCreatingTag(true)}
                                                                                    className="px-2 py-1 rounded-full text-xs font-medium border border-dashed border-slate-300 text-slate-400 hover:text-slate-600 hover:border-slate-400 flex items-center gap-1"
                                                                                >
                                                                                    <Plus className="w-3 h-3" />
                                                                                    新規作成
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    </div>

                                                                    {/* ステップ配信 */}
                                                                    <div className="space-y-2">
                                                                        <Label className="text-xs text-slate-500 flex items-center gap-1">
                                                                            <Play className="w-3 h-3" />
                                                                            ステップ配信を開始
                                                                        </Label>
                                                                        <select
                                                                            className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 dark:bg-slate-900 dark:border-slate-700"
                                                                            value={block.customActions?.scenarioId || ''}
                                                                            onChange={(e) => {
                                                                                const updatedActions = {
                                                                                    ...block.customActions,
                                                                                    scenarioId: e.target.value || undefined
                                                                                }
                                                                                updateBlock(index, { customActions: updatedActions })
                                                                            }}
                                                                        >
                                                                            <option value="">(なし)</option>
                                                                            {scenarios.map(scenario => (
                                                                                <option key={scenario.id} value={scenario.id}>
                                                                                    {scenario.name}
                                                                                </option>
                                                                            ))}
                                                                        </select>
                                                                    </div>

                                                                    {/* 自動返信 */}
                                                                    <div className="space-y-2">
                                                                        <Label className="text-xs text-slate-500 flex items-center gap-1">
                                                                            <MessageSquare className="w-3 h-3" />
                                                                            テキストを返信
                                                                        </Label>
                                                                        <Input
                                                                            className="text-sm"
                                                                            placeholder="例: ご応募ありがとうございます！"
                                                                            value={block.customActions?.replyText || ''}
                                                                            onChange={(e) => {
                                                                                const updatedActions = {
                                                                                    ...block.customActions,
                                                                                    replyText: e.target.value || undefined
                                                                                }
                                                                                updateBlock(index, { customActions: updatedActions })
                                                                            }}
                                                                        />
                                                                    </div>

                                                                    {/* URL遷移 */}
                                                                    <div className="space-y-2">
                                                                        <Label className="text-xs text-slate-500 flex items-center gap-1">
                                                                            <Link className="w-3 h-3" />
                                                                            Webページを開く
                                                                        </Label>
                                                                        <Input
                                                                            className="text-sm"
                                                                            placeholder="https://example.com"
                                                                            value={block.customActions?.redirectUrl || ''}
                                                                            onChange={(e) => {
                                                                                const updatedActions = {
                                                                                    ...block.customActions,
                                                                                    redirectUrl: e.target.value || undefined
                                                                                }
                                                                                updateBlock(index, { customActions: updatedActions })
                                                                            }}
                                                                        />
                                                                    </div>
                                                                </div>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            ) : (
                                                <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700">
                                                    {uploadingIndex === index ? (
                                                        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
                                                    ) : (
                                                        <>
                                                            <Upload className="w-8 h-8 text-slate-400 mb-2" />
                                                            <span className="text-sm text-slate-500">画像をアップロード</span>
                                                        </>
                                                    )}
                                                    <input
                                                        type="file"
                                                        accept="image/*"
                                                        className="hidden"
                                                        onChange={(e) => {
                                                            const file = e.target.files?.[0]
                                                            if (file) handleFileUpload(index, file, 'image')
                                                        }}
                                                    />
                                                </label>
                                            )}
                                        </div>
                                    )}

                                    {block.type === 'video' && (
                                        <div className="space-y-2">
                                            {block.videoUrl ? (
                                                <div className="relative">
                                                    <video
                                                        src={block.videoUrl}
                                                        className="max-h-48 rounded-lg"
                                                        controls
                                                    />
                                                    <button
                                                        onClick={() => updateBlock(index, { videoUrl: undefined })}
                                                        className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded-full"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            ) : (
                                                <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700">
                                                    {uploadingIndex === index ? (
                                                        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
                                                    ) : (
                                                        <>
                                                            <Upload className="w-8 h-8 text-slate-400 mb-2" />
                                                            <span className="text-sm text-slate-500">動画をアップロード</span>
                                                        </>
                                                    )}
                                                    <input
                                                        type="file"
                                                        accept="video/*"
                                                        className="hidden"
                                                        onChange={(e) => {
                                                            const file = e.target.files?.[0]
                                                            if (file) handleFileUpload(index, file, 'video')
                                                        }}
                                                    />
                                                </label>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}

                            <div className="flex flex-wrap gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => addBlock('text')}
                                    disabled={formBlocks.length >= MAX_BLOCKS}
                                    className="flex-1 sm:flex-none"
                                >
                                    <Type className="w-4 h-4 mr-2 sm:mr-0 md:mr-2" />
                                    <span className="sm:hidden md:inline">テキスト</span>
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => addBlock('image')}
                                    disabled={formBlocks.length >= MAX_BLOCKS}
                                    className="flex-1 sm:flex-none"
                                >
                                    <ImageIcon className="w-4 h-4 mr-2 sm:mr-0 md:mr-2" />
                                    <span className="sm:hidden md:inline">画像</span>
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => addBlock('video')}
                                    disabled={formBlocks.length >= MAX_BLOCKS}
                                    className="flex-1 sm:flex-none"
                                >
                                    <Video className="w-4 h-4 mr-2 sm:mr-0 md:mr-2" />
                                    <span className="sm:hidden md:inline">動画</span>
                                </Button>
                            </div>
                            {formBlocks.length >= MAX_BLOCKS && (
                                <span className="text-xs text-amber-500 flex items-center mt-2">
                                    ※ 一度に送信できるのは{MAX_BLOCKS}つまでです
                                </span>
                            )}
                        </div>

                        {/* タグフィルター */}
                        <div className="space-y-2">
                            <Label className="flex items-center gap-2">
                                <TagIcon className="w-4 h-4" />
                                配信対象を絞り込む（任意）
                            </Label>
                            <div className="flex flex-wrap gap-2">
                                {tags.map(tag => (
                                    <button
                                        key={tag.id}
                                        onClick={() => toggleTag(tag.id)}
                                        className={cn(
                                            "px-3 py-1.5 rounded-full text-sm font-medium transition-all duration-200",
                                            formSelectedTags.includes(tag.id)
                                                ? "text-white shadow-lg"
                                                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
                                        )}
                                        style={formSelectedTags.includes(tag.id) ? { backgroundColor: tag.color } : {}}
                                    >
                                        {tag.name}
                                    </button>
                                ))}
                                {tags.length === 0 && (
                                    <p className="text-sm text-slate-500">タグなし（全員に配信）</p>
                                )}
                            </div>
                        </div>

                        {/* 予約配信 */}
                        <div className="space-y-3">
                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="scheduled"
                                    checked={formScheduled}
                                    onChange={(e) => setFormScheduled(e.target.checked)}
                                    className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                                />
                                <Label htmlFor="scheduled" className="cursor-pointer flex items-center gap-2">
                                    <Calendar className="w-4 h-4" />
                                    予約配信
                                </Label>
                            </div>
                            {formScheduled && (
                                <Input
                                    type="datetime-local"
                                    value={formScheduledAt}
                                    onChange={(e) => setFormScheduledAt(e.target.value)}
                                    min={new Date().toISOString().slice(0, 16)}
                                />
                            )}
                        </div>

                        <div className="flex gap-2 justify-end">
                            <Button
                                variant="outline"
                                onClick={() => setShowTestModal(true)}
                                disabled={sending || !isFormValid()}
                            >
                                <Send className="w-4 h-4 mr-2" />
                                テスト送信
                            </Button>
                            <Button
                                onClick={handleSend}
                                disabled={sending || !isFormValid()}
                                className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white"
                            >
                                {sending ? (
                                    <>
                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                        送信中...
                                    </>
                                ) : (
                                    <>
                                        <Send className="w-4 h-4 mr-2" />
                                        {formScheduled ? '予約する' : '配信する'}
                                    </>
                                )}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* 配信履歴 */}
            <div className="space-y-4">
                <h2 className="text-lg font-semibold">配信履歴</h2>
                {messages.length > 0 ? (
                    <div className="space-y-3">
                        {messages.map(message => (
                            <Card key={message.id} className="hover:shadow-md transition-shadow">
                                <CardContent className="p-3 sm:p-4">
                                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                                {getStatusIcon(message.status)}
                                                <span className="text-sm text-slate-500">
                                                    {getStatusText(message.status)}
                                                </span>
                                            </div>
                                            <h3 className="font-medium truncate">{message.title}</h3>
                                            <p className="text-sm text-slate-500 line-clamp-2 mt-1">
                                                {getMessagePreview(message.content as any[])}
                                            </p>
                                        </div>
                                        <div className="flex flex-row sm:flex-col justify-between sm:justify-start items-center sm:items-end text-sm mt-2 sm:mt-0 border-t sm:border-0 pt-2 sm:pt-0 border-slate-100 dark:border-slate-700">
                                            <p className="text-slate-500 text-xs sm:text-sm">
                                                {formatDateTime(message.created_at)}
                                            </p>
                                            {message.status === 'sent' && (
                                                <p className="text-emerald-600 mt-1">
                                                    {message.success_count}/{message.total_recipients}人に配信
                                                </p>
                                            )}
                                            {message.status === 'scheduled' && message.scheduled_at && (
                                                <p className="text-amber-600 mt-1">
                                                    {formatDateTime(message.scheduled_at)}に配信予定
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                ) : (
                    <div className="text-center py-12">
                        <div className="w-16 h-16 mx-auto mb-4 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center">
                            <Send className="w-8 h-8 text-slate-400" />
                        </div>
                        <p className="text-slate-500 mb-4">配信履歴がありません</p>
                        <Button onClick={() => setIsCreating(true)}>
                            最初のメッセージを配信
                        </Button>
                    </div>
                )}
            </div>

            {/* テスト送信モーダル */}
            {showTestModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <Card className="w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col">
                        <CardHeader className="flex-none flex flex-row items-center justify-between border-b pb-4">
                            <CardTitle className="text-lg">テスト送信先を選択</CardTitle>
                            <button onClick={() => setShowTestModal(false)} className="p-2 hover:bg-slate-100 rounded-full">
                                <X className="w-5 h-5" />
                            </button>
                        </CardHeader>
                        <div className="flex-1 overflow-y-auto p-4 space-y-2">
                            {testUsers.length === 0 ? (
                                <div className="text-center py-8 text-slate-500">
                                    <p>送信可能な友だちが見つかりません</p>
                                </div>
                            ) : (
                                testUsers.map(user => (
                                    <button
                                        key={user.id}
                                        onClick={() => handleTestSend(user.line_user_id)}
                                        disabled={isTestSending}
                                        className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors text-left group"
                                    >
                                        <div className="w-10 h-10 rounded-full bg-slate-200 overflow-hidden flex-shrink-0">
                                            {user.picture_url ? (
                                                <img src={user.picture_url} alt={user.display_name} className="w-full h-full object-cover" />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-slate-400">
                                                    <Type className="w-5 h-5" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="font-medium text-slate-900 dark:text-slate-100 truncate">
                                                {user.display_name}
                                            </p>
                                        </div>
                                        <Send className="w-4 h-4 text-slate-400 group-hover:text-emerald-500 transition-colors opacity-0 group-hover:opacity-100" />
                                    </button>
                                ))
                            )}
                        </div>
                    </Card>
                </div>
            )}
        </div>
    )
}
