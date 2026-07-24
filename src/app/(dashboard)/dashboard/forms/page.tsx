'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { cn, formatDateTime, getCookie } from '@/lib/utils'
import type { Form, FormField, FormFieldType, Tag, MessageContent } from '@/types'
import {
    ClipboardList,
    Plus,
    X,
    Trash2,
    Loader2,
    Type,
    Image as ImageIcon,
    Upload,
    ChevronUp,
    ChevronDown,
    Copy,
    Check,
    Tag as TagIcon,
    Pencil,
    Eye,
    Link as LinkIcon,
} from 'lucide-react'

// 完了メッセージ用ブロック（テキスト/画像）
interface CompletionBlock {
    type: 'text' | 'image'
    text?: string
    imageUrl?: string
}

const FIELD_TYPE_LABELS: Record<FormFieldType, string> = {
    text: '1行テキスト',
    textarea: '複数行テキスト',
    email: 'メールアドレス',
    tel: '電話番号',
    number: '数値',
    date: '日付',
    select: 'プルダウン選択',
    radio: 'ラジオ（単一選択）',
    checkbox: 'チェックボックス（複数選択）',
}

const OPTION_TYPES: FormFieldType[] = ['select', 'radio', 'checkbox']

function genId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export default function FormsPage() {
    const [forms, setForms] = useState<Form[]>([])
    const [tags, setTags] = useState<Tag[]>([])
    const [responseCounts, setResponseCounts] = useState<Record<string, number>>({})
    const [loading, setLoading] = useState(true)
    const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)

    const [isEditing, setIsEditing] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [uploadingIndex, setUploadingIndex] = useState<number | null>(null)
    const [copiedId, setCopiedId] = useState<string | null>(null)

    // 回答閲覧
    const [viewingForm, setViewingForm] = useState<Form | null>(null)

    // フォーム編集state
    const [fName, setFName] = useState('')
    const [fTitle, setFTitle] = useState('')
    const [fDescription, setFDescription] = useState('')
    const [fFields, setFFields] = useState<FormField[]>([])
    const [fCompletion, setFCompletion] = useState<CompletionBlock[]>([{ type: 'text', text: '' }])
    const [fTagIds, setFTagIds] = useState<string[]>([])
    const [fActive, setFActive] = useState(true)

    const liffId = process.env.NEXT_PUBLIC_FORM_LIFF_ID

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

        const { data: formsData } = await supabase
            .from('forms')
            .select('*')
            .eq('channel_id', channelId)
            .order('created_at', { ascending: false })
        if (formsData) setForms(formsData as Form[])

        const { data: tagsData } = await supabase
            .from('tags')
            .select('*')
            .eq('channel_id', channelId)
        if (tagsData) setTags(tagsData)

        // 回答数を集計
        if (formsData && formsData.length > 0) {
            const counts: Record<string, number> = {}
            await Promise.all(
                formsData.map(async (f) => {
                    const { count } = await supabase
                        .from('form_responses')
                        .select('id', { count: 'exact', head: true })
                        .eq('form_id', f.id)
                    counts[f.id] = count || 0
                })
            )
            setResponseCounts(counts)
        }
    }

    const resetForm = () => {
        setFName('')
        setFTitle('')
        setFDescription('')
        setFFields([])
        setFCompletion([{ type: 'text', text: '' }])
        setFTagIds([])
        setFActive(true)
        setIsEditing(false)
        setEditingId(null)
    }

    const startCreate = () => {
        resetForm()
        setFFields([{ id: genId(), label: '', type: 'text', required: true }])
        setIsEditing(true)
    }

    const startEdit = (form: Form) => {
        setEditingId(form.id)
        setFName(form.name)
        setFTitle(form.title || '')
        setFDescription(form.description || '')
        setFFields(form.fields.length > 0 ? form.fields : [{ id: genId(), label: '', type: 'text', required: true }])
        setFCompletion(completionToBlocks(form.completion_message))
        setFTagIds(form.completion_tag_ids || [])
        setFActive(form.is_active)
        setIsEditing(true)
        if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    const completionToBlocks = (content: MessageContent[]): CompletionBlock[] => {
        if (!content || content.length === 0) return [{ type: 'text', text: '' }]
        return content.map((b): CompletionBlock => {
            if (b.type === 'image') {
                return { type: 'image', imageUrl: b.originalContentUrl || b.previewImageUrl }
            }
            return { type: 'text', text: b.text || '' }
        })
    }

    // ---- フィールド操作 ----
    const addField = () => {
        setFFields([...fFields, { id: genId(), label: '', type: 'text', required: true }])
    }
    const updateField = (index: number, updates: Partial<FormField>) => {
        const updated = [...fFields]
        updated[index] = { ...updated[index], ...updates }
        setFFields(updated)
    }
    const removeField = (index: number) => {
        setFFields(fFields.filter((_, i) => i !== index))
    }
    const moveField = (index: number, dir: -1 | 1) => {
        const target = index + dir
        if (target < 0 || target >= fFields.length) return
        const updated = [...fFields]
        ;[updated[index], updated[target]] = [updated[target], updated[index]]
        setFFields(updated)
    }

    // ---- 完了メッセージ操作 ----
    const addCompletionBlock = (type: 'text' | 'image') => {
        if (fCompletion.length >= 5) return
        setFCompletion([...fCompletion, { type }])
    }
    const updateCompletionBlock = (index: number, updates: Partial<CompletionBlock>) => {
        const updated = [...fCompletion]
        updated[index] = { ...updated[index], ...updates }
        setFCompletion(updated)
    }
    const removeCompletionBlock = (index: number) => {
        if (fCompletion.length === 1) return
        setFCompletion(fCompletion.filter((_, i) => i !== index))
    }

    const handleImageUpload = async (index: number, file: File) => {
        if (!currentChannelId) return
        setUploadingIndex(index)
        const supabase = createClient()
        try {
            const fileExt = file.name.split('.').pop()
            const fileName = `${Date.now()}.${fileExt}`
            const filePath = `forms/${currentChannelId}/images/${fileName}`
            const { error: uploadError } = await supabase.storage.from('line-assets').upload(filePath, file)
            if (uploadError) throw uploadError
            const { data: { publicUrl } } = supabase.storage.from('line-assets').getPublicUrl(filePath)
            updateCompletionBlock(index, { imageUrl: publicUrl })
        } catch (err) {
            console.error('アップロードエラー:', err)
            alert('画像のアップロードに失敗しました')
        }
        setUploadingIndex(null)
    }

    const toggleTag = (tagId: string) => {
        setFTagIds((prev) => (prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]))
    }

    const buildCompletionContent = (): MessageContent[] => {
        return fCompletion
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
        if (fFields.length === 0) return false
        if (fFields.some((f) => !f.label.trim())) return false
        // 選択系は選択肢が1つ以上必要
        if (fFields.some((f) => OPTION_TYPES.includes(f.type) && (!f.options || f.options.filter((o) => o.trim()).length === 0))) return false
        return true
    }

    const handleSave = async () => {
        if (!isValid() || !currentChannelId) return
        setSaving(true)
        const supabase = createClient()

        // 選択肢の空要素を除去して保存
        const cleanFields: FormField[] = fFields.map((f) => ({
            ...f,
            label: f.label.trim(),
            options: OPTION_TYPES.includes(f.type)
                ? (f.options || []).map((o) => o.trim()).filter(Boolean)
                : undefined,
        }))

        const payload = {
            channel_id: currentChannelId,
            name: fName.trim(),
            title: fTitle.trim() || null,
            description: fDescription.trim() || null,
            fields: cleanFields,
            completion_message: buildCompletionContent(),
            completion_tag_ids: fTagIds.length > 0 ? fTagIds : null,
            is_active: fActive,
        }

        try {
            if (editingId) {
                const { error } = await supabase.from('forms').update(payload).eq('id', editingId)
                if (error) throw error
            } else {
                const { error } = await supabase.from('forms').insert(payload)
                if (error) throw error
            }
            await fetchData(currentChannelId)
            resetForm()
        } catch (err) {
            console.error('保存エラー:', err)
            alert(err instanceof Error ? err.message : 'フォームの保存に失敗しました')
        }
        setSaving(false)
    }

    const handleDelete = async (formId: string) => {
        if (!confirm('このフォームを削除しますか？回答データも削除されます。')) return
        const supabase = createClient()
        const { error } = await supabase.from('forms').delete().eq('id', formId)
        if (error) {
            alert('削除に失敗しました')
            return
        }
        if (currentChannelId) await fetchData(currentChannelId)
    }

    const toggleActive = async (form: Form) => {
        const supabase = createClient()
        await supabase.from('forms').update({ is_active: !form.is_active }).eq('id', form.id)
        if (currentChannelId) await fetchData(currentChannelId)
    }

    const formUrl = (formId: string) =>
        liffId ? `https://liff.line.me/${liffId}?form=${formId}` : ''

    const copyUrl = async (formId: string) => {
        const url = formUrl(formId)
        if (!url) return
        try {
            await navigator.clipboard.writeText(url)
            setCopiedId(formId)
            setTimeout(() => setCopiedId(null), 2000)
        } catch {
            alert('コピーに失敗しました。手動でコピーしてください:\n' + url)
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
                        申込フォーム
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        リッチメニューから起動し、送信完了で自動返信を行うフォームを作成します
                    </p>
                </div>
                {!isEditing && (
                    <Button onClick={startCreate}>
                        <Plus className="w-4 h-4" />
                        新規フォーム
                    </Button>
                )}
            </div>

            {!liffId && (
                <div className="p-3 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 rounded-lg text-sm">
                    環境変数 <code className="font-mono">NEXT_PUBLIC_FORM_LIFF_ID</code> が未設定です。フォームのURL発行と起動には、フォーム用のLIFF ID（エンドポイント <code className="font-mono">/forms</code>）を設定してください。
                </div>
            )}

            {/* 編集フォーム */}
            {isEditing && (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>{editingId ? 'フォームを編集' : '新規フォーム作成'}</CardTitle>
                        <button onClick={resetForm} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">
                            <X className="w-5 h-5" />
                        </button>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {/* 基本情報 */}
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <Label>フォーム名（管理用）*</Label>
                                <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="例: 体験レッスン申込" />
                            </div>
                            <div className="space-y-2">
                                <Label>見出し（申込者に表示）</Label>
                                <Input value={fTitle} onChange={(e) => setFTitle(e.target.value)} placeholder="例: 体験レッスンのお申し込み" />
                            </div>
                            <div className="space-y-2">
                                <Label>説明文（任意）</Label>
                                <textarea
                                    value={fDescription}
                                    onChange={(e) => setFDescription(e.target.value)}
                                    placeholder="フォーム上部に表示する案内文"
                                    className="w-full h-20 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                                />
                            </div>
                        </div>

                        {/* 入力項目ビルダー */}
                        <div className="space-y-3">
                            <Label className="text-base">入力項目</Label>
                            {fFields.map((field, index) => (
                                <div key={field.id} className="p-3 sm:p-4 bg-slate-50 dark:bg-slate-800 rounded-xl space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-xs font-medium text-slate-400">項目 {index + 1}</span>
                                        <div className="flex items-center gap-1">
                                            <button onClick={() => moveField(index, -1)} disabled={index === 0} className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30">
                                                <ChevronUp className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => moveField(index, 1)} disabled={index === fFields.length - 1} className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30">
                                                <ChevronDown className="w-4 h-4" />
                                            </button>
                                            {fFields.length > 1 && (
                                                <button onClick={() => removeField(index)} className="p-1 text-red-500 hover:bg-red-50 rounded">
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div className="space-y-1.5">
                                            <Label className="text-xs text-slate-500">質問ラベル*</Label>
                                            <Input
                                                value={field.label}
                                                onChange={(e) => updateField(index, { label: e.target.value })}
                                                placeholder="例: お名前"
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label className="text-xs text-slate-500">入力タイプ</Label>
                                            <select
                                                className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 dark:bg-slate-900 dark:border-slate-700"
                                                value={field.type}
                                                onChange={(e) => {
                                                    const newType = e.target.value as FormFieldType
                                                    updateField(index, {
                                                        type: newType,
                                                        options: OPTION_TYPES.includes(newType) ? (field.options && field.options.length > 0 ? field.options : ['']) : undefined,
                                                    })
                                                }}
                                            >
                                                {(Object.keys(FIELD_TYPE_LABELS) as FormFieldType[]).map((t) => (
                                                    <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>

                                    {/* プレースホルダー（自由入力系のみ） */}
                                    {!OPTION_TYPES.includes(field.type) && field.type !== 'date' && (
                                        <div className="space-y-1.5">
                                            <Label className="text-xs text-slate-500">プレースホルダー（任意）</Label>
                                            <Input
                                                value={field.placeholder || ''}
                                                onChange={(e) => updateField(index, { placeholder: e.target.value })}
                                                placeholder="入力例のヒント"
                                            />
                                        </div>
                                    )}

                                    {/* 選択肢（select/radio/checkbox） */}
                                    {OPTION_TYPES.includes(field.type) && (
                                        <div className="space-y-2">
                                            <Label className="text-xs text-slate-500">選択肢</Label>
                                            {(field.options || []).map((opt, optIndex) => (
                                                <div key={optIndex} className="flex items-center gap-2">
                                                    <Input
                                                        value={opt}
                                                        onChange={(e) => {
                                                            const opts = [...(field.options || [])]
                                                            opts[optIndex] = e.target.value
                                                            updateField(index, { options: opts })
                                                        }}
                                                        placeholder={`選択肢 ${optIndex + 1}`}
                                                    />
                                                    <button
                                                        onClick={() => updateField(index, { options: (field.options || []).filter((_, i) => i !== optIndex) })}
                                                        className="p-2 text-red-500 hover:bg-red-50 rounded"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            ))}
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => updateField(index, { options: [...(field.options || []), ''] })}
                                            >
                                                <Plus className="w-3.5 h-3.5 mr-1" />
                                                選択肢を追加
                                            </Button>
                                        </div>
                                    )}

                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={field.required}
                                            onChange={(e) => updateField(index, { required: e.target.checked })}
                                            className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                                        />
                                        <span className="text-sm">必須項目にする</span>
                                    </label>
                                </div>
                            ))}
                            <Button variant="outline" size="sm" onClick={addField}>
                                <Plus className="w-4 h-4 mr-1" />
                                項目を追加
                            </Button>
                        </div>

                        {/* 完了時の自動返信 */}
                        <div className="space-y-3">
                            <Label className="text-base">送信完了時の自動返信</Label>
                            <p className="text-xs text-slate-500">
                                申込完了後にトーク画面へ自動送信されるメッセージです。テキストの <code className="font-mono">{'{name}'}</code> は友だちの名前に置き換わります。
                            </p>
                            {fCompletion.map((block, index) => (
                                <div key={index} className="p-3 sm:p-4 bg-slate-50 dark:bg-slate-800 rounded-xl space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            {block.type === 'text' ? <Type className="w-4 h-4 text-blue-500" /> : <ImageIcon className="w-4 h-4 text-green-500" />}
                                            <span className="text-sm font-medium">{block.type === 'text' ? 'テキスト' : '画像'}</span>
                                        </div>
                                        {fCompletion.length > 1 && (
                                            <button onClick={() => removeCompletionBlock(index)} className="p-1 text-red-500 hover:bg-red-50 rounded">
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>

                                    {block.type === 'text' && (
                                        <div className="relative">
                                            <textarea
                                                value={block.text || ''}
                                                onChange={(e) => updateCompletionBlock(index, { text: e.target.value })}
                                                placeholder="例: {name}さん、お申し込みありがとうございます！担当者より追ってご連絡いたします。"
                                                className="w-full h-28 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                                            />
                                            <button
                                                onClick={() => updateCompletionBlock(index, { text: (block.text || '') + '{name}' })}
                                                className="absolute bottom-2 right-2 text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 px-2 py-1 rounded border border-slate-300 dark:border-slate-600"
                                            >
                                                {'{name}'} 挿入
                                            </button>
                                        </div>
                                    )}

                                    {block.type === 'image' && (
                                        <div>
                                            {block.imageUrl ? (
                                                <div className="relative inline-block">
                                                    <img src={block.imageUrl} alt="プレビュー" className="max-h-48 rounded-lg object-contain bg-slate-100" />
                                                    <button
                                                        onClick={() => updateCompletionBlock(index, { imageUrl: undefined })}
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
                                <Button variant="outline" size="sm" onClick={() => addCompletionBlock('text')} disabled={fCompletion.length >= 5}>
                                    <Type className="w-4 h-4 mr-1" />
                                    テキスト
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => addCompletionBlock('image')} disabled={fCompletion.length >= 5}>
                                    <ImageIcon className="w-4 h-4 mr-1" />
                                    画像
                                </Button>
                            </div>
                        </div>

                        {/* 完了タグ付与 */}
                        <div className="space-y-3">
                            <Label className="text-base flex items-center gap-2">
                                <TagIcon className="w-4 h-4" />
                                完了時に付与するタグ（任意）
                            </Label>
                            <div className="flex flex-wrap gap-2">
                                {tags.map((tag) => (
                                    <button
                                        key={tag.id}
                                        onClick={() => toggleTag(tag.id)}
                                        className={cn(
                                            'px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                                            fTagIds.includes(tag.id) ? 'text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
                                        )}
                                        style={fTagIds.includes(tag.id) ? { backgroundColor: tag.color } : {}}
                                    >
                                        {tag.name}
                                    </button>
                                ))}
                                {tags.length === 0 && <p className="text-sm text-slate-500">タグがありません（タグ管理で作成できます）</p>}
                            </div>
                        </div>

                        {/* 公開設定 */}
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={fActive}
                                onChange={(e) => setFActive(e.target.checked)}
                                className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                            />
                            <span className="text-sm">このフォームを公開する（受付を有効にする）</span>
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

            {/* フォーム一覧 */}
            {!isEditing && (
                <div className="space-y-4">
                    {forms.length > 0 ? (
                        forms.map((form) => (
                            <Card key={form.id} className="hover:shadow-md transition-shadow">
                                <CardContent className="p-4">
                                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className={cn(
                                                    'text-xs px-2 py-0.5 rounded-full font-medium',
                                                    form.is_active ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'
                                                )}>
                                                    {form.is_active ? '公開中' : '停止中'}
                                                </span>
                                                <span className="text-xs text-slate-400">
                                                    {form.fields.length}項目 ・ 回答 {responseCounts[form.id] ?? 0}件
                                                </span>
                                            </div>
                                            <h3 className="font-semibold truncate">{form.name}</h3>
                                            {form.title && <p className="text-sm text-slate-500 truncate">{form.title}</p>}
                                            <p className="text-xs text-slate-400 mt-1">{formatDateTime(form.created_at)}</p>

                                            {/* リッチメニュー用URL */}
                                            {liffId && (
                                                <div className="mt-3 flex items-center gap-2 flex-wrap">
                                                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800 rounded-lg text-xs font-mono text-slate-600 dark:text-slate-300 max-w-full overflow-x-auto">
                                                        <LinkIcon className="w-3.5 h-3.5 flex-none text-slate-400" />
                                                        <span className="truncate">{formUrl(form.id)}</span>
                                                    </div>
                                                    <Button variant="outline" size="sm" onClick={() => copyUrl(form.id)}>
                                                        {copiedId === form.id ? <><Check className="w-3.5 h-3.5 mr-1 text-emerald-500" />コピー済</> : <><Copy className="w-3.5 h-3.5 mr-1" />URLをコピー</>}
                                                    </Button>
                                                </div>
                                            )}
                                        </div>

                                        <div className="flex items-center gap-1 flex-wrap">
                                            <Button variant="ghost" size="sm" onClick={() => setViewingForm(form)} className="text-slate-600">
                                                <Eye className="w-4 h-4 mr-1" />回答
                                            </Button>
                                            <Button variant="ghost" size="sm" onClick={() => toggleActive(form)} className="text-slate-600">
                                                {form.is_active ? '停止' : '公開'}
                                            </Button>
                                            <Button variant="ghost" size="sm" onClick={() => startEdit(form)} className="text-emerald-600">
                                                <Pencil className="w-4 h-4 mr-1" />編集
                                            </Button>
                                            <Button variant="ghost" size="sm" onClick={() => handleDelete(form.id)} className="text-red-500">
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        ))
                    ) : (
                        <div className="text-center py-12">
                            <div className="w-16 h-16 mx-auto mb-4 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center">
                                <ClipboardList className="w-8 h-8 text-slate-400" />
                            </div>
                            <p className="text-slate-500 mb-4">フォームがまだありません</p>
                            <Button onClick={startCreate}>
                                <Plus className="w-4 h-4 mr-1" />
                                最初のフォームを作成
                            </Button>
                        </div>
                    )}
                </div>
            )}

            {/* 回答閲覧モーダル */}
            {viewingForm && (
                <ResponsesModal form={viewingForm} onClose={() => setViewingForm(null)} />
            )}
        </div>
    )
}

// =============================================================================
// 回答閲覧モーダル
// =============================================================================
function ResponsesModal({ form, onClose }: { form: Form; onClose: () => void }) {
    const [responses, setResponses] = useState<{ id: string; answers: Record<string, string | string[]>; created_at: string }[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const fetchResponses = async () => {
            const supabase = createClient()
            const { data } = await supabase
                .from('form_responses')
                .select('id, answers, created_at')
                .eq('form_id', form.id)
                .order('created_at', { ascending: false })
                .limit(200)
            setResponses((data as { id: string; answers: Record<string, string | string[]>; created_at: string }[]) || [])
            setLoading(false)
        }
        fetchResponses()
    }, [form.id])

    const labelFor = (fieldId: string) => form.fields.find((f) => f.id === fieldId)?.label || fieldId

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <Card className="w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
                <CardHeader className="flex-none flex flex-row items-center justify-between border-b pb-4">
                    <CardTitle className="text-lg">「{form.name}」の回答（{responses.length}件）</CardTitle>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full">
                        <X className="w-5 h-5" />
                    </button>
                </CardHeader>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {loading ? (
                        <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-emerald-500" /></div>
                    ) : responses.length === 0 ? (
                        <p className="text-center text-slate-500 py-8">まだ回答がありません</p>
                    ) : (
                        responses.map((r) => (
                            <div key={r.id} className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800 space-y-1.5">
                                <p className="text-xs text-slate-400">{formatDateTime(r.created_at)}</p>
                                {form.fields.map((field) => {
                                    const val = r.answers[field.id]
                                    if (val === undefined || val === null || (Array.isArray(val) && val.length === 0) || val === '') return null
                                    return (
                                        <div key={field.id} className="text-sm">
                                            <span className="text-slate-500">{labelFor(field.id)}: </span>
                                            <span className="text-slate-800 dark:text-slate-200 break-words">
                                                {Array.isArray(val) ? val.join('、') : val}
                                            </span>
                                        </div>
                                    )
                                })}
                            </div>
                        ))
                    )}
                </div>
            </Card>
        </div>
    )
}
