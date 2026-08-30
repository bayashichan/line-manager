'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { cn, formatDateTime, getCookie } from '@/lib/utils'
// LineClient経由(@/lib/line)ではなく直接importする。indexはnode:cryptoを使う
// client.tsを再エクスポートしており、クライアントコンポーネントに引き込みたくないため。
import { MAX_TEXT_LENGTH, MAX_BLOCKS } from '@/lib/line/auto-reply'
import type { AutoReply, AutoReplyMatchType, MessageContent } from '@/types'
import {
    MessageSquareReply,
    Plus,
    X,
    Trash2,
    Loader2,
    Type,
    Image as ImageIcon,
    Upload,
    Pencil,
} from 'lucide-react'

// 応答内容のブロック（テキスト/画像）
interface ReplyBlock {
    type: 'text' | 'image'
    text?: string
    imageUrl?: string
}

export default function AutoRepliesPage() {
    const [rules, setRules] = useState<AutoReply[]>([])
    const [loading, setLoading] = useState(true)
    const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)

    const [isEditing, setIsEditing] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [uploadingIndex, setUploadingIndex] = useState<number | null>(null)

    // 編集state
    const [fName, setFName] = useState('')
    const [fKeywords, setFKeywords] = useState<string[]>([])
    const [fKeywordInput, setFKeywordInput] = useState('')
    const [fMatchType, setFMatchType] = useState<AutoReplyMatchType>('partial')
    const [fContent, setFContent] = useState<ReplyBlock[]>([{ type: 'text', text: '' }])
    const [fPriority, setFPriority] = useState(0)
    const [fActive, setFActive] = useState(true)

    useEffect(() => {
        fetchChannelAndData()
    }, [])

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

    const fetchData = async (channelId: string) => {
        const supabase = createClient()
        const { data } = await supabase
            .from('auto_replies')
            .select('*')
            .eq('channel_id', channelId)
            .order('priority', { ascending: false })
            .order('created_at', { ascending: true })
        if (data) setRules(data as AutoReply[])
    }

    // ---- 編集フォームの開閉 ----
    const resetForm = () => {
        setIsEditing(false)
        setEditingId(null)
        setFName('')
        setFKeywords([])
        setFKeywordInput('')
        setFMatchType('partial')
        setFContent([{ type: 'text', text: '' }])
        setFPriority(0)
        setFActive(true)
    }

    const startCreate = () => {
        resetForm()
        setIsEditing(true)
    }

    const startEdit = (rule: AutoReply) => {
        setEditingId(rule.id)
        setFName(rule.name)
        setFKeywords(rule.keywords || [])
        setFKeywordInput('')
        setFMatchType(rule.match_type)
        setFContent(contentToBlocks(rule.content))
        setFPriority(rule.priority)
        setFActive(rule.is_active)
        setIsEditing(true)
        if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    const contentToBlocks = (content: MessageContent[]): ReplyBlock[] => {
        if (!content || content.length === 0) return [{ type: 'text', text: '' }]
        return content.map((b): ReplyBlock => {
            if (b.type === 'image') {
                return { type: 'image', imageUrl: b.originalContentUrl || b.previewImageUrl }
            }
            return { type: 'text', text: b.text || '' }
        })
    }

    // ---- キーワード操作 ----
    const addKeyword = () => {
        const value = fKeywordInput.trim()
        if (!value) return
        if (fKeywords.includes(value)) {
            setFKeywordInput('')
            return
        }
        setFKeywords([...fKeywords, value])
        setFKeywordInput('')
    }

    const removeKeyword = (keyword: string) => {
        setFKeywords(fKeywords.filter((k) => k !== keyword))
    }

    // ---- 応答内容ブロック操作 ----
    const addBlock = (type: 'text' | 'image') => {
        if (fContent.length >= MAX_BLOCKS) return
        setFContent([...fContent, { type }])
    }
    const updateBlock = (index: number, updates: Partial<ReplyBlock>) => {
        const updated = [...fContent]
        updated[index] = { ...updated[index], ...updates }
        setFContent(updated)
    }
    const removeBlock = (index: number) => {
        if (fContent.length === 1) return
        setFContent(fContent.filter((_, i) => i !== index))
    }

    const handleImageUpload = async (index: number, file: File) => {
        if (!currentChannelId) return
        setUploadingIndex(index)
        const supabase = createClient()
        try {
            const fileExt = file.name.split('.').pop()
            const fileName = `${Date.now()}.${fileExt}`
            const filePath = `auto-replies/${currentChannelId}/images/${fileName}`
            const { error: uploadError } = await supabase.storage.from('line-assets').upload(filePath, file)
            if (uploadError) throw uploadError
            const { data: { publicUrl } } = supabase.storage.from('line-assets').getPublicUrl(filePath)
            updateBlock(index, { imageUrl: publicUrl })
        } catch (err) {
            console.error('アップロードエラー:', err)
            alert('画像のアップロードに失敗しました')
        }
        setUploadingIndex(null)
    }

    const buildContent = (): MessageContent[] => {
        return fContent
            .map((b): MessageContent | null => {
                if (b.type === 'text') {
                    if (!b.text || !b.text.trim()) return null
                    return { type: 'text', text: b.text }
                }
                if (b.type === 'image') {
                    if (!b.imageUrl) return null
                    return { type: 'image', originalContentUrl: b.imageUrl, previewImageUrl: b.imageUrl }
                }
                return null
            })
            .filter((b): b is MessageContent => b !== null)
    }

    const isValid = () => {
        if (!fName.trim()) return false
        if (fKeywords.length === 0) return false
        if (fContent.some((b) => b.type === 'text' && (b.text || '').length > MAX_TEXT_LENGTH)) return false
        return buildContent().length > 0
    }

    const handleSave = async () => {
        if (!currentChannelId || !isValid()) return
        setSaving(true)
        const supabase = createClient()

        const payload = {
            channel_id: currentChannelId,
            name: fName.trim(),
            keywords: fKeywords,
            match_type: fMatchType,
            content: buildContent(),
            priority: fPriority,
            is_active: fActive,
        }

        try {
            const { error } = editingId
                ? await supabase.from('auto_replies').update(payload).eq('id', editingId)
                : await supabase.from('auto_replies').insert(payload)
            if (error) throw error
            await fetchData(currentChannelId)
            resetForm()
        } catch (err) {
            console.error('保存エラー:', err)
            alert('保存に失敗しました')
        }
        setSaving(false)
    }

    const handleDelete = async (ruleId: string) => {
        if (!confirm('この自動応答を削除しますか？')) return
        const supabase = createClient()
        const { error } = await supabase.from('auto_replies').delete().eq('id', ruleId)
        if (error) {
            alert('削除に失敗しました')
            return
        }
        if (currentChannelId) await fetchData(currentChannelId)
    }

    const toggleActive = async (rule: AutoReply) => {
        const supabase = createClient()
        await supabase.from('auto_replies').update({ is_active: !rule.is_active }).eq('id', rule.id)
        if (currentChannelId) await fetchData(currentChannelId)
    }

    const summarize = (content: MessageContent[]): string => {
        const first = content.find((b) => b.type === 'text' && b.text)
        if (first?.text) return first.text.length > 60 ? `${first.text.slice(0, 60)}…` : first.text
        return content.length > 0 ? '画像' : '（内容なし）'
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
                        自動応答
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        友だちからのメッセージにキーワードで自動返信します
                    </p>
                </div>
                {!isEditing && (
                    <Button onClick={startCreate}>
                        <Plus className="w-4 h-4" />
                        新規作成
                    </Button>
                )}
            </div>

            <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 rounded-lg text-sm">
                自動応答は LINE の応答（Reply）API で送信されるため、<strong>メッセージ配信の送信枠を消費しません</strong>。
                テキストは1吹き出しあたり {MAX_TEXT_LENGTH.toLocaleString()} 文字まで入るので、長文でも分割は不要です。
            </div>

            {/* 編集フォーム */}
            {isEditing && (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>{editingId ? '自動応答を編集' : '自動応答を作成'}</CardTitle>
                        <button onClick={resetForm} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">
                            <X className="w-5 h-5" />
                        </button>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {/* 基本情報 */}
                        <div className="space-y-2">
                            <Label>名称（管理用）*</Label>
                            <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="例: 資料請求への自動返信" />
                        </div>

                        {/* キーワード */}
                        <div className="space-y-3">
                            <Label className="text-base">キーワード*</Label>
                            <p className="text-xs text-slate-500">
                                友だちの送信内容がここに登録した語のいずれかに一致したら返信します。表記ゆれ（例: 資料 / しりょう）は複数登録してください。
                            </p>
                            <div className="flex gap-2">
                                <Input
                                    value={fKeywordInput}
                                    onChange={(e) => setFKeywordInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault()
                                            addKeyword()
                                        }
                                    }}
                                    placeholder="例: 資料"
                                />
                                <Button variant="outline" onClick={addKeyword} disabled={!fKeywordInput.trim()}>
                                    <Plus className="w-4 h-4 mr-1" />
                                    追加
                                </Button>
                            </div>
                            {fKeywords.length > 0 && (
                                <div className="flex flex-wrap gap-2">
                                    {fKeywords.map((keyword) => (
                                        <span
                                            key={keyword}
                                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                                        >
                                            {keyword}
                                            <button onClick={() => removeKeyword(keyword)} className="text-slate-400 hover:text-red-500">
                                                <X className="w-3.5 h-3.5" />
                                            </button>
                                        </span>
                                    ))}
                                </div>
                            )}
                            <div className="flex flex-wrap gap-4">
                                {(['partial', 'exact'] as AutoReplyMatchType[]).map((type) => (
                                    <label key={type} className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="matchType"
                                            checked={fMatchType === type}
                                            onChange={() => setFMatchType(type)}
                                            className="w-4 h-4 text-emerald-600 focus:ring-emerald-500"
                                        />
                                        <span className="text-sm">
                                            {type === 'partial' ? '部分一致（キーワードを含めば反応）' : '完全一致（メッセージ全体が一致したときだけ反応）'}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </div>

                        {/* 応答内容 */}
                        <div className="space-y-3">
                            <Label className="text-base">応答内容</Label>
                            <p className="text-xs text-slate-500">
                                テキストの <code className="font-mono">{'{name}'}</code> は友だちの名前に置き換わります。吹き出しは最大 {MAX_BLOCKS} 個までです。
                            </p>
                            {fContent.map((block, index) => (
                                <div key={index} className="p-3 sm:p-4 bg-slate-50 dark:bg-slate-800 rounded-xl space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            {block.type === 'text' ? <Type className="w-4 h-4 text-blue-500" /> : <ImageIcon className="w-4 h-4 text-green-500" />}
                                            <span className="text-sm font-medium">{block.type === 'text' ? 'テキスト' : '画像'}</span>
                                        </div>
                                        {fContent.length > 1 && (
                                            <button onClick={() => removeBlock(index)} className="p-1 text-red-500 hover:bg-red-50 rounded">
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>

                                    {block.type === 'text' && (
                                        <div className="space-y-1">
                                            <div className="relative">
                                                <textarea
                                                    value={block.text || ''}
                                                    onChange={(e) => updateBlock(index, { text: e.target.value })}
                                                    placeholder="例: {name}さん、お問い合わせありがとうございます！"
                                                    className="w-full h-40 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                                                />
                                                <button
                                                    onClick={() => updateBlock(index, { text: (block.text || '') + '{name}' })}
                                                    className="absolute bottom-2 right-2 text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 px-2 py-1 rounded border border-slate-300 dark:border-slate-600"
                                                >
                                                    {'{name}'} 挿入
                                                </button>
                                            </div>
                                            <div className="text-right text-xs">
                                                <span className={cn((block.text || '').length > MAX_TEXT_LENGTH ? 'text-red-500 font-medium' : 'text-slate-500')}>
                                                    {(block.text || '').length}
                                                </span>
                                                <span className="text-slate-400"> / {MAX_TEXT_LENGTH}文字</span>
                                            </div>
                                        </div>
                                    )}

                                    {block.type === 'image' && (
                                        <div>
                                            {block.imageUrl ? (
                                                <div className="relative inline-block">
                                                    <img src={block.imageUrl} alt="プレビュー" className="max-h-48 rounded-lg object-contain bg-slate-100" />
                                                    <button
                                                        onClick={() => updateBlock(index, { imageUrl: undefined })}
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
                                                            <span className="text-sm text-slate-500">画像をアップロード</span>
                                                        </>
                                                    )}
                                                    <input
                                                        type="file"
                                                        accept="image/*"
                                                        className="hidden"
                                                        onChange={(e) => {
                                                            const file = e.target.files?.[0]
                                                            if (file) handleImageUpload(index, file)
                                                        }}
                                                    />
                                                </label>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                            <div className="flex gap-2">
                                <Button variant="outline" size="sm" onClick={() => addBlock('text')} disabled={fContent.length >= MAX_BLOCKS}>
                                    <Type className="w-4 h-4 mr-1" />
                                    テキスト
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => addBlock('image')} disabled={fContent.length >= MAX_BLOCKS}>
                                    <ImageIcon className="w-4 h-4 mr-1" />
                                    画像
                                </Button>
                            </div>
                        </div>

                        {/* 優先度 */}
                        <div className="space-y-2">
                            <Label>優先度</Label>
                            <Input
                                type="number"
                                value={fPriority}
                                onChange={(e) => setFPriority(Number(e.target.value) || 0)}
                                className="max-w-32"
                            />
                            <p className="text-xs text-slate-500">
                                複数のルールが一致した場合、この数値が大きいものだけが返信されます（返信は必ず1件のみ）。
                            </p>
                        </div>

                        {/* 有効設定 */}
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={fActive}
                                onChange={(e) => setFActive(e.target.checked)}
                                className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                            />
                            <span className="text-sm">この自動応答を有効にする</span>
                        </label>

                        <div className="flex gap-2 justify-end pt-2">
                            <Button variant="outline" onClick={resetForm}>キャンセル</Button>
                            <Button
                                onClick={handleSave}
                                disabled={saving || !isValid()}
                                className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white"
                            >
                                {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />保存中...</> : (editingId ? '更新する' : '作成する')}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* 一覧 */}
            {!isEditing && (
                <div className="space-y-4">
                    {rules.length > 0 ? (
                        rules.map((rule) => (
                            <Card key={rule.id} className="hover:shadow-md transition-shadow">
                                <CardContent className="p-4">
                                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                <span className={cn(
                                                    'text-xs px-2 py-0.5 rounded-full font-medium',
                                                    rule.is_active ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'
                                                )}>
                                                    {rule.is_active ? '有効' : '停止中'}
                                                </span>
                                                <span className="text-xs text-slate-400">
                                                    {rule.match_type === 'exact' ? '完全一致' : '部分一致'} ・ 吹き出し {rule.content.length}個 ・ 優先度 {rule.priority}
                                                </span>
                                            </div>
                                            <h3 className="font-semibold truncate">{rule.name}</h3>
                                            <div className="flex flex-wrap gap-1.5 mt-2">
                                                {rule.keywords.map((keyword) => (
                                                    <span key={keyword} className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                                        {keyword}
                                                    </span>
                                                ))}
                                            </div>
                                            <p className="text-sm text-slate-500 mt-2 truncate">{summarize(rule.content)}</p>
                                            <p className="text-xs text-slate-400 mt-1">{formatDateTime(rule.created_at)}</p>
                                        </div>

                                        <div className="flex items-center gap-1 flex-wrap">
                                            <Button variant="ghost" size="sm" onClick={() => toggleActive(rule)} className="text-slate-600">
                                                {rule.is_active ? '停止' : '有効化'}
                                            </Button>
                                            <Button variant="ghost" size="sm" onClick={() => startEdit(rule)} className="text-emerald-600">
                                                <Pencil className="w-4 h-4 mr-1" />編集
                                            </Button>
                                            <Button variant="ghost" size="sm" onClick={() => handleDelete(rule.id)} className="text-red-500">
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        ))
                    ) : (
                        <Card>
                            <CardContent className="p-12 text-center">
                                <MessageSquareReply className="w-12 h-12 mx-auto text-slate-300 mb-3" />
                                <p className="text-slate-500">まだ自動応答がありません</p>
                                <Button onClick={startCreate} className="mt-4">
                                    <Plus className="w-4 h-4" />
                                    最初の自動応答を作成
                                </Button>
                            </CardContent>
                        </Card>
                    )}
                </div>
            )}
        </div>
    )
}
