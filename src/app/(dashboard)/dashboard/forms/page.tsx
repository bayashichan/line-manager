'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { cn, formatDateTime, getCookie } from '@/lib/utils'
import type { Form, FormEntryStatus, FormField, FormFieldType, FormFullAction, FormResponse, Tag, MessageContent } from '@/types'
import { uploadToR2 } from '@/lib/storage/upload-client'
import { computeAvailability, DEFAULT_WAITLIST_MESSAGE, FEW_SEATS_THRESHOLD } from '@/lib/forms/capacity'
import { CompletionReplyBadge, completionReplyDetail, completionReplyLabel } from '@/components/completion-reply-status'
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
    Download,
    Armchair,
    UserCheck,
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
    // キャンセル待ちの件数（残席設定がオンのフォームのみ集計）
    const [waitlistCounts, setWaitlistCounts] = useState<Record<string, number>>({})
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
    // 残席設定
    const [fCapacityEnabled, setFCapacityEnabled] = useState(false)
    const [fCapacity, setFCapacity] = useState('')
    const [fFullAction, setFFullAction] = useState<FormFullAction>('waitlist')
    const [fWaitlistMessage, setFWaitlistMessage] = useState('')
    const [fWaitlistTagIds, setFWaitlistTagIds] = useState<string[]>([])
    // 重複申込の防止（1人1回まで。2回目以降は申込内容の修正として受け付ける）
    const [fOnePerUser, setFOnePerUser] = useState(true)

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

        // 回答数を集計（残席設定がオンのフォームはキャンセル待ちの件数も数え、残席を出す）
        if (formsData && formsData.length > 0) {
            const counts: Record<string, number> = {}
            const waitlisted: Record<string, number> = {}
            await Promise.all(
                (formsData as Form[]).map(async (f) => {
                    const { count } = await supabase
                        .from('form_responses')
                        .select('id', { count: 'exact', head: true })
                        .eq('form_id', f.id)
                    counts[f.id] = count || 0

                    if (f.capacity_enabled) {
                        const { count: waitCount } = await supabase
                            .from('form_responses')
                            .select('id', { count: 'exact', head: true })
                            .eq('form_id', f.id)
                            .eq('entry_status', 'waitlisted')
                        waitlisted[f.id] = waitCount || 0
                    }
                })
            )
            setResponseCounts(counts)
            setWaitlistCounts(waitlisted)
        }
    }

    // 申込数（キャンセル待ちを除く）
    const confirmedCountOf = (formId: string) =>
        (responseCounts[formId] ?? 0) - (waitlistCounts[formId] ?? 0)

    const resetForm = () => {
        setFName('')
        setFTitle('')
        setFDescription('')
        setFFields([])
        setFCompletion([{ type: 'text', text: '' }])
        setFTagIds([])
        setFActive(true)
        setFCapacityEnabled(false)
        setFCapacity('')
        setFFullAction('waitlist')
        setFWaitlistMessage('')
        setFWaitlistTagIds([])
        setFOnePerUser(true)
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
        setFCapacityEnabled(!!form.capacity_enabled)
        setFCapacity(form.capacity ? String(form.capacity) : '')
        setFFullAction(form.full_action === 'close' ? 'close' : 'waitlist')
        setFWaitlistMessage(form.waitlist_message || '')
        setFWaitlistTagIds(form.waitlist_tag_ids || [])
        setFOnePerUser(form.one_response_per_user !== false)
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
        try {
            // 回答完了メッセージの画像もLINE側から都度取得されるため、転送量無料のR2に置く
            const publicUrl = await uploadToR2(file, currentChannelId, {
                prefix: 'forms',
                compress: true,
            })
            updateCompletionBlock(index, { imageUrl: publicUrl })
        } catch (err) {
            console.error('アップロードエラー:', err)
            alert(err instanceof Error ? err.message : '画像のアップロードに失敗しました')
        }
        setUploadingIndex(null)
    }

    const toggleTag = (tagId: string) => {
        setFTagIds((prev) => (prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]))
    }
    const toggleWaitlistTag = (tagId: string) => {
        setFWaitlistTagIds((prev) => (prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]))
    }

    // 定員は1以上の整数。入力途中や不正な値は null
    const parsedCapacity = (): number | null => {
        const n = Number(fCapacity)
        return Number.isInteger(n) && n >= 1 ? n : null
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
        if (fCapacityEnabled && parsedCapacity() === null) return false
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
            description: f.description?.trim() || undefined,
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
            // オフにしても定員の数値は残しておく（再度オンにしたとき入力し直さなくて済むように）
            capacity_enabled: fCapacityEnabled,
            capacity: parsedCapacity(),
            full_action: fFullAction,
            waitlist_message: fWaitlistMessage.trim() || null,
            waitlist_tag_ids: fWaitlistTagIds.length > 0 ? fWaitlistTagIds : null,
            one_response_per_user: fOnePerUser,
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

                                    {/* 質問の説明文 */}
                                    <div className="space-y-1.5">
                                        <Label className="text-xs text-slate-500">質問の説明文（任意）</Label>
                                        <textarea
                                            value={field.description || ''}
                                            onChange={(e) => updateField(index, { description: e.target.value })}
                                            placeholder="質問の下に表示する補足説明（例: 日中つながりやすい番号をご入力ください）"
                                            className="w-full h-16 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                                        />
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
                            <TagPicker tags={tags} selectedIds={fTagIds} onToggle={toggleTag} />
                        </div>

                        {/* 残席設定 */}
                        <div className="space-y-3">
                            <Label className="text-base flex items-center gap-2">
                                <Armchair className="w-4 h-4" />
                                残席設定
                            </Label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={fCapacityEnabled}
                                    onChange={(e) => setFCapacityEnabled(e.target.checked)}
                                    className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                                />
                                <span className="text-sm">定員を設定する（フォームに残席数を表示し、満席になったら自動で切り替えます）</span>
                            </label>

                            {fCapacityEnabled && (
                                <div className="p-3 sm:p-4 bg-slate-50 dark:bg-slate-800 rounded-xl space-y-4">
                                    <div className="space-y-1.5">
                                        <Label className="text-xs text-slate-500">定員*</Label>
                                        <div className="flex items-center gap-2">
                                            <Input
                                                type="number"
                                                inputMode="numeric"
                                                min={1}
                                                step={1}
                                                value={fCapacity}
                                                onChange={(e) => setFCapacity(e.target.value)}
                                                placeholder="例: 20"
                                                className="w-32"
                                            />
                                            <span className="text-sm text-slate-600 dark:text-slate-300">席</span>
                                        </div>
                                        {fCapacity !== '' && parsedCapacity() === null && (
                                            <p className="text-xs text-red-500">1以上の整数で入力してください</p>
                                        )}
                                        {editingId && parsedCapacity() !== null && (
                                            <p className="text-xs text-slate-500">
                                                現在の申込 {confirmedCountOf(editingId)} 件（残り {Math.max(0, parsedCapacity()! - confirmedCountOf(editingId))} 席
                                                {(waitlistCounts[editingId] ?? 0) > 0 && ` ・ キャンセル待ち ${waitlistCounts[editingId]} 件`}）
                                            </p>
                                        )}
                                        <p className="text-xs text-slate-400">
                                            キャンセル待ちを除いた申込の数で数えます。回答を削除すると席が空きます。
                                        </p>
                                    </div>

                                    <div className="space-y-2">
                                        <Label className="text-xs text-slate-500">満席になったら</Label>
                                        {([
                                            { value: 'waitlist', label: 'キャンセル待ちとして受け付ける', hint: '満席後の申込は「キャンセル待ち」として保存され、回答一覧から繰り上げできます' },
                                            { value: 'close', label: '申込を締め切る', hint: 'フォームに「受付を終了しました」と表示し、申込できなくなります' },
                                        ] as const).map((opt) => (
                                            <label
                                                key={opt.value}
                                                className={cn(
                                                    'flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer bg-white dark:bg-slate-900',
                                                    fFullAction === opt.value ? 'border-emerald-500' : 'border-slate-200 dark:border-slate-700'
                                                )}
                                            >
                                                <input
                                                    type="radio"
                                                    name="full-action"
                                                    checked={fFullAction === opt.value}
                                                    onChange={() => setFFullAction(opt.value)}
                                                    className="mt-0.5 w-4 h-4 accent-emerald-600"
                                                />
                                                <span>
                                                    <span className="block text-sm font-medium">{opt.label}</span>
                                                    <span className="block text-xs text-slate-500 mt-0.5">{opt.hint}</span>
                                                </span>
                                            </label>
                                        ))}
                                    </div>

                                    {fFullAction === 'waitlist' && (
                                        <>
                                            <div className="space-y-1.5">
                                                <Label className="text-xs text-slate-500">キャンセル待ちの自動返信</Label>
                                                <p className="text-xs text-slate-400">
                                                    キャンセル待ちで受け付けた人には「送信完了時の自動返信」の代わりにこの文面を送ります。空欄なら入力欄の薄い文字の文面を送ります。
                                                </p>
                                                <div className="relative">
                                                    <textarea
                                                        value={fWaitlistMessage}
                                                        onChange={(e) => setFWaitlistMessage(e.target.value)}
                                                        placeholder={DEFAULT_WAITLIST_MESSAGE}
                                                        className="w-full h-28 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                                                    />
                                                    <button
                                                        onClick={() => setFWaitlistMessage(fWaitlistMessage + '{name}')}
                                                        className="absolute bottom-2 right-2 text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 px-2 py-1 rounded border border-slate-300 dark:border-slate-600"
                                                    >
                                                        {'{name}'} 挿入
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="space-y-1.5">
                                                <Label className="text-xs text-slate-500 flex items-center gap-1.5">
                                                    <TagIcon className="w-3.5 h-3.5" />
                                                    キャンセル待ちの人に付与するタグ（任意）
                                                </Label>
                                                <p className="text-xs text-slate-400">
                                                    キャンセル待ちの人には「完了時に付与するタグ」は付けず、こちらのタグを付けます。
                                                </p>
                                                <TagPicker tags={tags} selectedIds={fWaitlistTagIds} onToggle={toggleWaitlistTag} />
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* 重複申込 */}
                        <div className="space-y-3">
                            <Label className="text-base flex items-center gap-2">
                                <UserCheck className="w-4 h-4" />
                                重複申込
                            </Label>
                            <label className="flex items-start gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={fOnePerUser}
                                    onChange={(e) => setFOnePerUser(e.target.checked)}
                                    className="mt-0.5 w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                                />
                                <span>
                                    <span className="block text-sm">同じ人からの申込は1回までにする（2回目以降は申込内容の修正として受け付ける）</span>
                                    <span className="block text-xs text-slate-500 mt-0.5">
                                        申込済みの人がフォームを開くと「お申し込み済みです。内容を修正しますか？」と表示します。修正すると、新しい申込は増やさずに今の申込内容を書き換え、修正後の内容をトークへ送ります（申込状態・タグ・完了時の自動返信は最初の申込のまま）。
                                    </span>
                                    <span className="block text-xs text-slate-400 mt-0.5">
                                        問い合わせやアンケートなど、何度でも送ってよいフォームはオフにしてください。
                                    </span>
                                </span>
                            </label>
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
                                                    {form.one_response_per_user && ' ・ 1人1回まで'}
                                                </span>
                                            </div>
                                            <CapacityBadge
                                                form={form}
                                                confirmedCount={confirmedCountOf(form.id)}
                                                waitlistCount={waitlistCounts[form.id] ?? 0}
                                            />
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
                <ResponsesModal
                    form={viewingForm}
                    onClose={() => setViewingForm(null)}
                    onChanged={() => { if (currentChannelId) fetchData(currentChannelId) }}
                />
            )}
        </div>
    )
}

// =============================================================================
// タグ選択（完了タグ・キャンセル待ちタグで共用）
// =============================================================================
function TagPicker({ tags, selectedIds, onToggle }: { tags: Tag[]; selectedIds: string[]; onToggle: (tagId: string) => void }) {
    return (
        <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
                <button
                    key={tag.id}
                    onClick={() => onToggle(tag.id)}
                    className={cn(
                        'px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                        selectedIds.includes(tag.id) ? 'text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
                    )}
                    style={selectedIds.includes(tag.id) ? { backgroundColor: tag.color } : {}}
                >
                    {tag.name}
                </button>
            ))}
            {tags.length === 0 && <p className="text-sm text-slate-500">タグがありません（タグ管理で作成できます）</p>}
        </div>
    )
}

// =============================================================================
// 一覧カードの残席表示（残席設定がオフなら何も出さない）
// =============================================================================
function CapacityBadge({ form, confirmedCount, waitlistCount }: { form: Form; confirmedCount: number; waitlistCount: number }) {
    const availability = computeAvailability(form, confirmedCount)
    if (!availability) return null

    const { capacity, remaining, state } = availability
    const label =
        state === 'open' ? `残り ${remaining} 席 / 定員 ${capacity} 席`
        : state === 'waitlist' ? `満席（定員 ${capacity} 席）・キャンセル待ち受付中`
        : `満席（定員 ${capacity} 席）・受付終了`
    const tone =
        state === 'open'
            ? remaining <= FEW_SEATS_THRESHOLD
                ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-300'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
            : state === 'waitlist'
                ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'

    return (
        <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={cn('inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium', tone)}>
                <Armchair className="w-3.5 h-3.5" />
                {label}
            </span>
            {waitlistCount > 0 && (
                <span className="text-xs text-amber-700 dark:text-amber-300">キャンセル待ち {waitlistCount}件</span>
            )}
        </div>
    )
}

// =============================================================================
// 回答閲覧モーダル（テーブル表示＋CSVダウンロード）
// =============================================================================
type FormResponseRow = Pick<
    FormResponse,
    'id' | 'answers' | 'created_at' | 'edited_at' | 'entry_status' | 'completion_reply_status' | 'completion_reply_error'
>

const ENTRY_STATUS_LABELS: Record<FormEntryStatus, string> = {
    confirmed: '申込',
    waitlisted: 'キャンセル待ち',
}

function ResponsesModal({ form, onClose, onChanged }: { form: Form; onClose: () => void; onChanged?: () => void }) {
    const [responses, setResponses] = useState<FormResponseRow[]>([])
    const [loading, setLoading] = useState(true)
    const [editing, setEditing] = useState<FormResponseRow | null>(null)
    const [editValues, setEditValues] = useState<Record<string, string | string[]>>({})
    const [savingEdit, setSavingEdit] = useState(false)
    const [deletingId, setDeletingId] = useState<string | null>(null)
    const [changingStatusId, setChangingStatusId] = useState<string | null>(null)

    useEffect(() => {
        const fetchResponses = async () => {
            const supabase = createClient()
            // 列を指定しない: 自動返信の送信結果の列はマイグレーション適用前には無く、指定すると取得ごと失敗する
            const { data } = await supabase
                .from('form_responses')
                .select('*')
                .eq('form_id', form.id)
                .order('created_at', { ascending: false })
                .limit(1000)
            setResponses((data as FormResponseRow[]) || [])
            setLoading(false)
        }
        fetchResponses()
    }, [form.id])

    // マイグレーション適用前の回答には申込状態が無いので、通常の申込として扱う
    const isWaitlisted = (r: FormResponseRow) => r.entry_status === 'waitlisted'
    const showEntryStatus = !!form.capacity_enabled || responses.some(isWaitlisted)
    const confirmedCount = responses.filter((r) => !isWaitlisted(r)).length
    const waitlistCount = responses.length - confirmedCount

    // キャンセル待ちの順番（申込が早い順）。繰り上げる順番の目安にする
    const waitlistOrder = new Map(
        responses
            .filter(isWaitlisted)
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .map((r, i) => [r.id, i + 1])
    )

    const entryStatusText = (r: FormResponseRow) =>
        isWaitlisted(r) ? `${ENTRY_STATUS_LABELS.waitlisted}（${waitlistOrder.get(r.id)}番目）` : ENTRY_STATUS_LABELS.confirmed

    const changeEntryStatus = async (r: FormResponseRow, next: FormEntryStatus) => {
        if (next === 'confirmed') {
            const over = form.capacity_enabled && form.capacity != null && confirmedCount >= form.capacity
            const message = [
                over
                    ? `定員（${form.capacity}席）に達していますが、この回答を繰り上げますか？（定員を超えて申込扱いになります）`
                    : 'この回答をキャンセル待ちから繰り上げて、申込扱いにしますか？',
                'ご本人への連絡やタグの付け替えは自動では行いません。',
            ].join('\n')
            if (!confirm(message)) return
        } else if (!confirm('この回答をキャンセル待ちに戻しますか？（席が1つ空きます）')) {
            return
        }

        setChangingStatusId(r.id)
        const supabase = createClient()
        const { error } = await supabase
            .from('form_responses')
            .update({ entry_status: next })
            .eq('id', r.id)
        setChangingStatusId(null)
        if (error) {
            alert('申込状態の変更に失敗しました')
            return
        }
        setResponses((prev) => prev.map((x) => (x.id === r.id ? { ...x, entry_status: next } : x)))
        onChanged?.()
    }

    const cellValue = (r: FormResponseRow, fieldId: string): string => {
        const val = r.answers[fieldId]
        if (val === undefined || val === null) return ''
        return Array.isArray(val) ? val.join('、') : String(val)
    }

    const startEdit = (r: FormResponseRow) => {
        setEditValues({ ...r.answers })
        setEditing(r)
    }

    const setEditValue = (fieldId: string, value: string | string[]) => {
        setEditValues((prev) => ({ ...prev, [fieldId]: value }))
    }

    const toggleEditCheckbox = (fieldId: string, option: string) => {
        setEditValues((prev) => {
            const current = Array.isArray(prev[fieldId]) ? (prev[fieldId] as string[]) : []
            const next = current.includes(option) ? current.filter((o) => o !== option) : [...current, option]
            return { ...prev, [fieldId]: next }
        })
    }

    const saveEdit = async () => {
        if (!editing) return
        setSavingEdit(true)
        const supabase = createClient()
        const { error } = await supabase
            .from('form_responses')
            .update({ answers: editValues })
            .eq('id', editing.id)
        setSavingEdit(false)
        if (error) {
            alert('更新に失敗しました')
            return
        }
        setResponses((prev) => prev.map((r) => (r.id === editing.id ? { ...r, answers: editValues } : r)))
        setEditing(null)
        onChanged?.()
    }

    const deleteResponse = async (r: FormResponseRow) => {
        if (!confirm('この回答を削除しますか？この操作は取り消せません。')) return
        setDeletingId(r.id)
        const supabase = createClient()
        const { error } = await supabase.from('form_responses').delete().eq('id', r.id)
        setDeletingId(null)
        if (error) {
            alert('削除に失敗しました')
            return
        }
        setResponses((prev) => prev.filter((x) => x.id !== r.id))
        onChanged?.()
    }

    const downloadCsv = () => {
        const escape = (v: string) => {
            const s = v ?? ''
            return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        }
        const headers = ['送信日時', '本人による修正日時', '申込状態', '自動返信', '自動返信の理由', ...form.fields.map((f) => f.label)]
        const rows = responses.map((r) => [
            formatDateTime(r.created_at),
            r.edited_at ? formatDateTime(r.edited_at) : '',
            entryStatusText(r),
            completionReplyLabel(r),
            completionReplyDetail(r) || '',
            ...form.fields.map((f) => cellValue(r, f.id)),
        ])
        const csv = [headers, ...rows].map((row) => row.map(escape).join(',')).join('\r\n')
        // Excelでの文字化け防止のためUTF-8 BOMを付与
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${form.name}_回答_${new Date().toISOString().slice(0, 10)}.csv`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <Card className="w-full max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
                <CardHeader className="flex-none flex flex-row items-center justify-between border-b pb-4 gap-3">
                    <div className="min-w-0">
                        <CardTitle className="text-lg truncate">「{form.name}」の回答（{responses.length}件）</CardTitle>
                        {!loading && showEntryStatus && (
                            <p className="text-xs text-slate-500 mt-1">
                                申込 {confirmedCount} 件
                                {form.capacity_enabled && form.capacity != null && ` / 定員 ${form.capacity} 席（残り ${Math.max(0, form.capacity - confirmedCount)} 席）`}
                                {' ・ '}キャンセル待ち {waitlistCount} 件
                            </p>
                        )}
                    </div>
                    <div className="flex items-center gap-2 flex-none">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={downloadCsv}
                            disabled={loading || responses.length === 0}
                        >
                            <Download className="w-4 h-4 mr-1" />
                            CSVダウンロード
                        </Button>
                        <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </CardHeader>
                <div className="flex-1 overflow-auto">
                    {loading ? (
                        <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-emerald-500" /></div>
                    ) : responses.length === 0 ? (
                        <p className="text-center text-slate-500 py-8">まだ回答がありません</p>
                    ) : (
                        <table className="w-full text-sm border-collapse">
                            <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-800">
                                <tr>
                                    <th className="text-left font-semibold px-3 py-2 whitespace-nowrap border-b border-slate-200 dark:border-slate-700">送信日時</th>
                                    {showEntryStatus && (
                                        <th className="text-left font-semibold px-3 py-2 whitespace-nowrap border-b border-slate-200 dark:border-slate-700">申込状態</th>
                                    )}
                                    <th className="text-left font-semibold px-3 py-2 whitespace-nowrap border-b border-slate-200 dark:border-slate-700">自動返信</th>
                                    {form.fields.map((field) => (
                                        <th key={field.id} className="text-left font-semibold px-3 py-2 whitespace-nowrap border-b border-slate-200 dark:border-slate-700">
                                            {field.label}
                                        </th>
                                    ))}
                                    <th className="text-right font-semibold px-3 py-2 whitespace-nowrap border-b border-slate-200 dark:border-slate-700 sticky right-0 bg-slate-100 dark:bg-slate-800">操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                {responses.map((r, i) => (
                                    <tr key={r.id} className={cn(i % 2 === 1 && 'bg-slate-50 dark:bg-slate-800/40')}>
                                        <td className="px-3 py-2 whitespace-nowrap text-slate-500 align-top">
                                            {formatDateTime(r.created_at)}
                                            {r.edited_at && (
                                                <span className="block text-xs text-sky-600 dark:text-sky-400">
                                                    {formatDateTime(r.edited_at)} 本人が修正
                                                </span>
                                            )}
                                        </td>
                                        {showEntryStatus && (
                                            <td className="px-3 py-2 align-top whitespace-nowrap">
                                                <span className={cn(
                                                    'px-2 py-0.5 text-xs rounded-full',
                                                    isWaitlisted(r)
                                                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                                        : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                                                )}>
                                                    {entryStatusText(r)}
                                                </span>
                                                <div className="mt-1">
                                                    {changingStatusId === r.id ? (
                                                        <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />
                                                    ) : isWaitlisted(r) ? (
                                                        <button
                                                            onClick={() => changeEntryStatus(r, 'confirmed')}
                                                            className="text-xs text-emerald-600 hover:underline"
                                                        >
                                                            繰り上げる
                                                        </button>
                                                    ) : form.capacity_enabled ? (
                                                        <button
                                                            onClick={() => changeEntryStatus(r, 'waitlisted')}
                                                            className="text-xs text-slate-400 hover:text-slate-600 hover:underline"
                                                        >
                                                            キャンセル待ちに戻す
                                                        </button>
                                                    ) : null}
                                                </div>
                                            </td>
                                        )}
                                        <td className="px-3 py-2 align-top min-w-[8rem] max-w-xs">
                                            {r.completion_reply_status ? (
                                                <>
                                                    <CompletionReplyBadge record={r} />
                                                    {completionReplyDetail(r) && (
                                                        <p className="mt-1 text-xs text-slate-500 break-words">{completionReplyDetail(r)}</p>
                                                    )}
                                                </>
                                            ) : (
                                                <span className="text-xs text-slate-400">{completionReplyLabel(r)}</span>
                                            )}
                                        </td>
                                        {form.fields.map((field) => (
                                            <td key={field.id} className="px-3 py-2 align-top text-slate-800 dark:text-slate-200 max-w-xs break-words">
                                                {cellValue(r, field.id)}
                                            </td>
                                        ))}
                                        <td className={cn(
                                            'px-3 py-2 align-top whitespace-nowrap text-right sticky right-0',
                                            i % 2 === 1 ? 'bg-slate-50 dark:bg-slate-800/40' : 'bg-white dark:bg-slate-900'
                                        )}>
                                            <div className="flex items-center justify-end gap-1">
                                                <button
                                                    onClick={() => startEdit(r)}
                                                    className="p-1.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded"
                                                    title="編集"
                                                >
                                                    <Pencil className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() => deleteResponse(r)}
                                                    disabled={deletingId === r.id}
                                                    className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded disabled:opacity-50"
                                                    title="削除"
                                                >
                                                    {deletingId === r.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </Card>

            {/* 回答の編集ダイアログ */}
            {editing && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => !savingEdit && setEditing(null)}>
                    <Card className="w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <CardHeader className="flex-none flex flex-row items-center justify-between border-b pb-4">
                            <CardTitle className="text-lg">回答を編集</CardTitle>
                            <button onClick={() => !savingEdit && setEditing(null)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full">
                                <X className="w-5 h-5" />
                            </button>
                        </CardHeader>
                        <div className="flex-1 overflow-y-auto p-4 space-y-4">
                            <p className="text-xs text-slate-400">{formatDateTime(editing.created_at)} の回答</p>
                            {form.fields.map((field) => (
                                <div key={field.id} className="space-y-1.5">
                                    <Label className="text-sm">{field.label}</Label>
                                    <ResponseEditField
                                        field={field}
                                        value={editValues[field.id]}
                                        onChange={(v) => setEditValue(field.id, v)}
                                        onToggleCheckbox={(opt) => toggleEditCheckbox(field.id, opt)}
                                    />
                                </div>
                            ))}
                        </div>
                        <div className="flex-none flex justify-end gap-2 p-4 border-t">
                            <Button variant="outline" onClick={() => setEditing(null)} disabled={savingEdit}>キャンセル</Button>
                            <Button onClick={saveEdit} disabled={savingEdit} className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white">
                                {savingEdit ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />保存中...</> : '保存する'}
                            </Button>
                        </div>
                    </Card>
                </div>
            )}
        </div>
    )
}

// =============================================================================
// 回答編集用の入力コンポーネント
// =============================================================================
function ResponseEditField({
    field,
    value,
    onChange,
    onToggleCheckbox,
}: {
    field: FormField
    value: string | string[] | undefined
    onChange: (v: string) => void
    onToggleCheckbox: (option: string) => void
}) {
    const base = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500'

    switch (field.type) {
        case 'textarea':
            return (
                <textarea
                    className={`${base} min-h-[80px] resize-y`}
                    value={(value as string) || ''}
                    onChange={(e) => onChange(e.target.value)}
                />
            )
        case 'select':
            return (
                <select className={base} value={(value as string) || ''} onChange={(e) => onChange(e.target.value)}>
                    <option value="">選択してください</option>
                    {(field.options || []).map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                    ))}
                </select>
            )
        case 'radio':
            return (
                <div className="space-y-1.5">
                    {(field.options || []).map((opt) => (
                        <label key={opt} className="flex items-center gap-2 cursor-pointer text-sm">
                            <input type="radio" name={`edit-${field.id}`} checked={value === opt} onChange={() => onChange(opt)} className="w-4 h-4 accent-emerald-600" />
                            {opt}
                        </label>
                    ))}
                </div>
            )
        case 'checkbox':
            return (
                <div className="space-y-1.5">
                    {(field.options || []).map((opt) => {
                        const checked = Array.isArray(value) && value.includes(opt)
                        return (
                            <label key={opt} className="flex items-center gap-2 cursor-pointer text-sm">
                                <input type="checkbox" checked={checked} onChange={() => onToggleCheckbox(opt)} className="w-4 h-4 accent-emerald-600" />
                                {opt}
                            </label>
                        )
                    })}
                </div>
            )
        default: {
            const inputType =
                field.type === 'email' ? 'email' :
                field.type === 'tel' ? 'tel' :
                field.type === 'number' ? 'number' :
                field.type === 'date' ? 'date' : 'text'
            return (
                <Input type={inputType} value={(value as string) || ''} onChange={(e) => onChange(e.target.value)} />
            )
        }
    }
}
