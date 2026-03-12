'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { cn, formatDelayMinutes, getCookie } from '@/lib/utils'
import type { StepScenario, StepMessage, Tag } from '@/types'
import {
    Plus,
    Edit2,
    Trash2,
    Save,
    Play,
    Pause,
    Loader2,
    X,
    Clock,
    MessageCircle,
    Tag as TagIcon,
    ChevronDown,
    ChevronUp,
    Users,
    Rocket,
    Search,
    Type,
    Image as ImageIcon,
    Video,
    Settings,
} from 'lucide-react'
import imageCompression from 'browser-image-compression'

type MessageType = 'text' | 'image' | 'video'

interface MessageBlock {
    type: MessageType
    text?: string
    imageUrl?: string
    videoUrl?: string
    previewUrl?: string
    width?: number
    height?: number
    imageType?: 'normal' | 'rich'
    customActions?: {
        tagIds?: string[]
        scenarioId?: string
        replyText?: string
        redirectUrl?: string
    }
}

interface StepScenarioWithMessages extends StepScenario {
    step_messages: StepMessage[]
    trigger_tag?: Tag
}

interface FormStep {
    delayDays: number
    sendHour: number | null
    sendMinute: number
    blocks: MessageBlock[]
}

interface LineUser {
    id: string
    display_name: string
    picture_url: string | null
    line_user_id: string
}

export default function StepPage() {
    const [scenarios, setScenarios] = useState<StepScenarioWithMessages[]>([])
    const [tags, setTags] = useState<Tag[]>([])
    const [loading, setLoading] = useState(true)
    const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)
    const [isCreating, setIsCreating] = useState(false)
    const [editingScenario, setEditingScenario] = useState<StepScenarioWithMessages | null>(null)
    const [expandedScenario, setExpandedScenario] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    // フォーム
    const [formName, setFormName] = useState('')
    const [formTriggerType, setFormTriggerType] = useState<'follow' | 'tag_assigned'>('follow')
    const [formTriggerTagId, setFormTriggerTagId] = useState<string | null>(null)
    const [formSteps, setFormSteps] = useState<FormStep[]>([
        { delayDays: 0, sendHour: null, sendMinute: 0, blocks: [{ type: 'text', text: '' }] }
    ])

    const [newTagName, setNewTagName] = useState('')
    const [isCreatingTag, setIsCreatingTag] = useState(false)
    const [uploadingStepIndex, setUploadingStepIndex] = useState<number | null>(null)
    const [uploadingBlockIndex, setUploadingBlockIndex] = useState<number | null>(null)

    // 手動開始モーダル
    const [manualStartScenario, setManualStartScenario] = useState<StepScenarioWithMessages | null>(null)
    const [manualTargetType, setManualTargetType] = useState<'users' | 'tag'>('users')
    const [manualStartStep, setManualStartStep] = useState(1)
    const [manualTagId, setManualTagId] = useState<string | null>(null)
    const [manualSelectedUsers, setManualSelectedUsers] = useState<string[]>([])
    const [manualSearchQuery, setManualSearchQuery] = useState('')
    const [allUsers, setAllUsers] = useState<LineUser[]>([])
    const [loadingUsers, setLoadingUsers] = useState(false)
    const [manualStarting, setManualStarting] = useState(false)
    const [manualResult, setManualResult] = useState<string | null>(null)

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

        const { data: scenariosData } = await supabase
            .from('step_scenarios')
            .select(`
        *,
        step_messages (*),
        trigger_tag:tags (*)
      `)
            .eq('channel_id', channelId)
            .order('created_at', { ascending: false })

        if (scenariosData) {
            const sorted = scenariosData.map(s => ({
                ...s,
                step_messages: (s.step_messages || []).sort((a: StepMessage, b: StepMessage) => a.step_order - b.step_order)
            }))
            setScenarios(sorted as StepScenarioWithMessages[])
        }

        const { data: tagsData } = await supabase
            .from('tags')
            .select('*')
            .eq('channel_id', channelId)
            .order('name')

        if (tagsData) {
            setTags(tagsData)
        }
    }

    const fetchUsers = async () => {
        if (!currentChannelId || allUsers.length > 0) return
        setLoadingUsers(true)
        const supabase = createClient()
        const { data } = await supabase
            .from('line_users')
            .select('id, display_name, picture_url, line_user_id')
            .eq('channel_id', currentChannelId)
            .eq('is_blocked', false)
            .order('display_name')
            .limit(500)

        if (data) {
            setAllUsers(data as LineUser[])
        }
        setLoadingUsers(false)
    }

    const minutesToDays = (minutes: number): number => Math.floor(minutes / 1440)

    const resetForm = () => {
        setFormName('')
        setFormTriggerType('follow')
        setFormTriggerTagId(null)
        setFormSteps([{ delayDays: 0, sendHour: null, sendMinute: 0, blocks: [{ type: 'text', text: '' }] }])
        setEditingScenario(null)
        setIsCreating(false)
    }

    const startCreating = () => {
        resetForm()
        setIsCreating(true)
    }

    const startEditing = (scenario: StepScenarioWithMessages) => {
        setEditingScenario(scenario)
        setFormName(scenario.name)
        setFormTriggerType(scenario.trigger_type)
        setFormTriggerTagId(scenario.trigger_tag_id)

        // 既存データ（contentの配列）をMessageBlockの形に変換
        const mappedSteps = scenario.step_messages.map(sm => {
            const rawContent = Array.isArray(sm.content) ? sm.content : [sm.content]
            const blocks: MessageBlock[] = rawContent.map((item: any) => {
                const base: MessageBlock = { type: item.type as MessageType }
                if (item.type === 'text') {
                    base.text = item.text
                } else if (item.type === 'image') {
                    base.imageUrl = item.originalContentUrl
                    base.imageType = item.customActions ? 'rich' : 'normal'
                    base.customActions = item.customActions
                } else if (item.type === 'video') {
                    base.videoUrl = item.originalContentUrl
                    base.previewUrl = item.previewImageUrl
                }
                return base
            })

            return {
                delayDays: minutesToDays(sm.delay_minutes),
                sendHour: sm.send_hour ?? null,
                sendMinute: sm.send_minute ?? 0,
                blocks: blocks.length > 0 ? blocks : [{ type: 'text' as MessageType, text: '' }]
            }
        })

        setFormSteps(mappedSteps)
        setIsCreating(false)
    }

    const addStep = () => {
        setFormSteps([...formSteps, { delayDays: 1, sendHour: 10, sendMinute: 0, blocks: [{ type: 'text', text: '' }] }])
    }

    const removeStep = (index: number) => {
        if (formSteps.length === 1) return
        setFormSteps(formSteps.filter((_, i) => i !== index))
    }

    const updateStep = (index: number, field: keyof FormStep, value: any) => {
        const updated = [...formSteps]
        updated[index] = { ...updated[index], [field]: value }
        if (field === 'delayDays' && value === 0) {
            updated[index].sendHour = null
            updated[index].sendMinute = 0
        }
        if (field === 'delayDays' && value > 0 && updated[index].sendHour === null) {
            updated[index].sendHour = 10
            updated[index].sendMinute = 0
        }
        setFormSteps(updated)
    }

    const addBlock = (stepIndex: number, type: MessageType) => {
        const newSteps = [...formSteps]
        newSteps[stepIndex].blocks.push({ type })
        setFormSteps(newSteps)
    }

    const removeBlock = (stepIndex: number, blockIndex: number) => {
        const newSteps = [...formSteps]
        if (newSteps[stepIndex].blocks.length === 1) return
        newSteps[stepIndex].blocks = newSteps[stepIndex].blocks.filter((_, i) => i !== blockIndex)
        setFormSteps(newSteps)
    }

    const updateBlock = (stepIndex: number, blockIndex: number, updates: Partial<MessageBlock>) => {
        const newSteps = [...formSteps]
        newSteps[stepIndex].blocks[blockIndex] = { ...newSteps[stepIndex].blocks[blockIndex], ...updates }
        setFormSteps(newSteps)
    }

    const getImageDimensions = (url: string): Promise<{ width: number; height: number }> => {
        return new Promise((resolve) => {
            const img = new Image()
            img.onload = () => resolve({ width: img.width, height: img.height })
            img.onerror = () => resolve({ width: 0, height: 0 })
            img.src = url
        })
    }

    const handleFileUpload = async (stepIndex: number, blockIndex: number, file: File, type: 'image' | 'video') => {
        if (!currentChannelId) return

        setUploadingStepIndex(stepIndex)
        setUploadingBlockIndex(blockIndex)
        const supabase = createClient()

        try {
            const fileExt = file.name.split('.').pop()
            const fileName = `${Date.now()}.${fileExt}`
            const folder = type === 'image' ? 'images' : 'videos'
            const filePath = `steps/${currentChannelId}/${folder}/${fileName}`

            const { error: uploadError } = await supabase.storage
                .from('line-assets')
                .upload(filePath, file)

            if (uploadError) throw uploadError

            const { data: { publicUrl } } = supabase.storage
                .from('line-assets')
                .getPublicUrl(filePath)

            if (type === 'image') {
                const { width, height } = await getImageDimensions(publicUrl)
                updateBlock(stepIndex, blockIndex, { imageUrl: publicUrl, width, height })
            } else {
                updateBlock(stepIndex, blockIndex, { videoUrl: publicUrl })
            }
        } catch (error) {
            console.error('アップロードエラー:', error)
            alert('アップロードに失敗しました')
        }

        setUploadingStepIndex(null)
        setUploadingBlockIndex(null)
    }

    const handleCreateTag = async () => {
        if (!newTagName.trim() || !currentChannelId) return

        const supabase = createClient()
        const { data, error } = await supabase.from('tags').insert({
            channel_id: currentChannelId,
            name: newTagName,
            color: '#3B82F6',
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

    const buildContentFromBlocks = (blocks: MessageBlock[]) => {
        return blocks.map(block => {
            if (block.type === 'text') {
                return { type: 'text', text: block.text || '' }
            } else if (block.type === 'image') {
                return {
                    type: 'image',
                    originalContentUrl: block.imageUrl,
                    previewImageUrl: block.imageUrl,
                    customActions: block.customActions ? {
                        tagIds: block.customActions.tagIds?.length ? block.customActions.tagIds : undefined,
                        scenarioId: block.customActions.scenarioId,
                        replyText: block.customActions.replyText,
                        redirectUrl: block.customActions.redirectUrl
                    } : undefined,
                    aspectRatio: block.width && block.height ? block.width / block.height : undefined,
                }
            } else if (block.type === 'video') {
                return {
                    type: 'video',
                    originalContentUrl: block.videoUrl,
                    previewImageUrl: block.previewUrl || block.videoUrl,
                }
            }
            return null
        }).filter(Boolean)
    }

    const isStepValid = (step: FormStep) => {
        return step.blocks.every(b => {
            if (b.type === 'text') return !!b.text?.trim()
            if (b.type === 'image') return !!b.imageUrl
            if (b.type === 'video') return !!b.videoUrl
            return false
        })
    }

    const handleSave = async () => {
        if (!formName.trim() || !currentChannelId || formSteps.some(s => !isStepValid(s))) return

        setSaving(true)
        const supabase = createClient()

        try {
            if (editingScenario) {
                await supabase
                    .from('step_scenarios')
                    .update({
                        name: formName,
                        trigger_type: formTriggerType,
                        trigger_tag_id: formTriggerType === 'tag_assigned' ? formTriggerTagId : null,
                    })
                    .eq('id', editingScenario.id)

                await supabase
                    .from('step_messages')
                    .delete()
                    .eq('scenario_id', editingScenario.id)

                for (let i = 0; i < formSteps.length; i++) {
                    await supabase.from('step_messages').insert({
                        scenario_id: editingScenario.id,
                        step_order: i + 1,
                        delay_minutes: formSteps[i].delayDays * 1440,
                        send_hour: formSteps[i].sendHour,
                        send_minute: formSteps[i].sendMinute,
                        content: buildContentFromBlocks(formSteps[i].blocks),
                    })
                }
            } else {
                const { data: scenario } = await supabase
                    .from('step_scenarios')
                    .insert({
                        channel_id: currentChannelId,
                        name: formName,
                        trigger_type: formTriggerType,
                        trigger_tag_id: formTriggerType === 'tag_assigned' ? formTriggerTagId : null,
                        is_active: true,
                    })
                    .select()
                    .single()

                if (scenario) {
                    for (let i = 0; i < formSteps.length; i++) {
                        await supabase.from('step_messages').insert({
                            scenario_id: scenario.id,
                            step_order: i + 1,
                            delay_minutes: formSteps[i].delayDays * 1440,
                            send_hour: formSteps[i].sendHour,
                            send_minute: formSteps[i].sendMinute,
                            content: buildContentFromBlocks(formSteps[i].blocks),
                        })
                    }
                }
            }

            await fetchData(currentChannelId)
            resetForm()
        } catch (error) {
            console.error('保存エラー:', error)
        }

        setSaving(false)
    }

    const toggleActive = async (scenarioId: string, currentActive: boolean) => {
        const supabase = createClient()
        await supabase
            .from('step_scenarios')
            .update({ is_active: !currentActive })
            .eq('id', scenarioId)

        if (currentChannelId) {
            await fetchData(currentChannelId)
        }
    }

    const handleDelete = async (scenarioId: string) => {
        if (!confirm('このシナリオを削除しますか？')) return

        const supabase = createClient()
        await supabase.from('step_scenarios').delete().eq('id', scenarioId)

        if (currentChannelId) {
            await fetchData(currentChannelId)
        }
    }

    // 手動開始モーダル
    const openManualStart = async (scenario: StepScenarioWithMessages) => {
        setManualStartScenario(scenario)
        setManualTargetType('users')
        setManualStartStep(1)
        setManualTagId(null)
        setManualSelectedUsers([])
        setManualSearchQuery('')
        setManualResult(null)
        await fetchUsers()
    }

    const closeManualStart = () => {
        setManualStartScenario(null)
        setManualResult(null)
    }

    const toggleUserSelection = (userId: string) => {
        setManualSelectedUsers(prev =>
            prev.includes(userId)
                ? prev.filter(id => id !== userId)
                : [...prev, userId]
        )
    }

    const selectAllFilteredUsers = () => {
        const filtered = filteredUsers.map(u => u.id)
        const allSelected = filtered.every(id => manualSelectedUsers.includes(id))
        if (allSelected) {
            setManualSelectedUsers(prev => prev.filter(id => !filtered.includes(id)))
        } else {
            setManualSelectedUsers(prev => [...new Set([...prev, ...filtered])])
        }
    }

    const handleManualStart = async () => {
        if (!manualStartScenario) return

        setManualStarting(true)
        setManualResult(null)

        try {
            const res = await fetch('/api/step-executions/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    scenarioId: manualStartScenario.id,
                    startStep: manualStartStep,
                    targetType: manualTargetType,
                    userIds: manualTargetType === 'users' ? manualSelectedUsers : undefined,
                    tagId: manualTargetType === 'tag' ? manualTagId : undefined,
                }),
            })

            const data = await res.json()

            if (res.ok) {
                setManualResult(data.message)
            } else {
                setManualResult(`エラー: ${data.error}`)
            }
        } catch (error) {
            setManualResult('エラーが発生しました')
        }

        setManualStarting(false)
    }

    const filteredUsers = allUsers.filter(u =>
        u.display_name?.toLowerCase().includes(manualSearchQuery.toLowerCase())
    )

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
                        ステップ配信
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        {scenarios.length}個のシナリオ
                    </p>
                </div>
                <Button onClick={startCreating}>
                    <Plus className="w-4 h-4" />
                    シナリオ作成
                </Button>
            </div>

            {/* 作成/編集フォーム */}
            {(isCreating || editingScenario) && (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>{editingScenario ? 'シナリオを編集' : '新しいシナリオ'}</CardTitle>
                        <button onClick={resetForm} className="p-2 hover:bg-slate-100 rounded-lg">
                            <X className="w-5 h-5" />
                        </button>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label>シナリオ名</Label>
                                <Input
                                    value={formName}
                                    onChange={(e) => setFormName(e.target.value)}
                                    placeholder="例: ウェルカムメッセージ"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>トリガー</Label>
                                <select
                                    value={formTriggerType}
                                    onChange={(e) => setFormTriggerType(e.target.value as 'follow' | 'tag_assigned')}
                                    className="w-full h-10 px-3 rounded-lg border border-slate-200 bg-white/50 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-800/50"
                                >
                                    <option value="follow">友だち追加時</option>
                                    <option value="tag_assigned">タグ付与時</option>
                                </select>
                            </div>
                        </div>

                        {formTriggerType === 'tag_assigned' && (
                            <div className="space-y-2">
                                <Label className="flex items-center gap-2">
                                    <TagIcon className="w-4 h-4" />
                                    トリガータグ
                                </Label>
                                <select
                                    value={formTriggerTagId || ''}
                                    onChange={(e) => setFormTriggerTagId(e.target.value || null)}
                                    className="w-full h-10 px-3 rounded-lg border border-slate-200 bg-white/50 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-800/50"
                                >
                                    <option value="">タグを選択</option>
                                    {tags.map(tag => (
                                        <option key={tag.id} value={tag.id}>{tag.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* ステップ一覧 */}
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <Label>ステップメッセージ</Label>
                                <Button variant="outline" size="sm" onClick={addStep}>
                                    <Plus className="w-4 h-4" />
                                    ステップ追加
                                </Button>
                            </div>

                            {formSteps.map((step, index) => (
                                <div key={index} className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="font-medium">ステップ {index + 1}</span>
                                        {formSteps.length > 1 && (
                                            <button
                                                onClick={() => removeStep(index)}
                                                className="p-1 text-red-500 hover:bg-red-50 rounded"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <Clock className="w-4 h-4 text-slate-400" />
                                        <select
                                            value={step.delayDays}
                                            onChange={(e) => updateStep(index, 'delayDays', parseInt(e.target.value))}
                                            className="h-9 px-3 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-800"
                                        >
                                            <option value={0}>即時</option>
                                            <option value={1}>1日後</option>
                                            <option value={2}>2日後</option>
                                            <option value={3}>3日後</option>
                                            <option value={5}>5日後</option>
                                            <option value={7}>7日後</option>
                                            <option value={10}>10日後</option>
                                            <option value={14}>14日後</option>
                                            <option value={21}>21日後</option>
                                            <option value={30}>30日後</option>
                                        </select>
                                        {step.delayDays > 0 && (
                                            <>
                                                <span className="text-sm text-slate-500">の</span>
                                                <select
                                                    value={step.sendHour ?? 10}
                                                    onChange={(e) => updateStep(index, 'sendHour', parseInt(e.target.value))}
                                                    className="h-9 px-3 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-800"
                                                >
                                                    {Array.from({ length: 24 }, (_, h) => (
                                                        <option key={h} value={h}>{h}</option>
                                                    ))}
                                                </select>
                                                <span className="text-sm text-slate-500">:</span>
                                                <select
                                                    value={step.sendMinute}
                                                    onChange={(e) => updateStep(index, 'sendMinute', parseInt(e.target.value))}
                                                    className="h-9 px-3 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-800"
                                                >
                                                    {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                                                        <option key={m} value={m}>{m.toString().padStart(2, '0')}</option>
                                                    ))}
                                                </select>
                                            </>
                                        )}
                                        <span className="text-sm text-slate-500">に配信</span>
                                    </div>
                                    <div className="space-y-4">
                                        {step.blocks.map((block, blockIndex) => (
                                            <div key={blockIndex} className="p-3 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700">
                                                <div className="flex justify-between items-center mb-2">
                                                    <span className="text-xs font-medium text-slate-500">
                                                        {block.type === 'text' && 'テキスト'}
                                                        {block.type === 'image' && '画像'}
                                                        {block.type === 'video' && '動画'}
                                                    </span>
                                                    {step.blocks.length > 1 && (
                                                        <button
                                                            onClick={() => removeBlock(index, blockIndex)}
                                                            className="text-slate-400 hover:text-red-500"
                                                        >
                                                            <X className="w-4 h-4" />
                                                        </button>
                                                    )}
                                                </div>

                                                {block.type === 'text' && (
                                                    <textarea
                                                        value={block.text || ''}
                                                        onChange={(e) => updateBlock(index, blockIndex, { text: e.target.value })}
                                                        placeholder="メッセージを入力..."
                                                        className="w-full min-h-[100px] px-3 py-2 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-800 resize-none"
                                                    />
                                                )}

                                                {block.type === 'image' && (
                                                    <div className="space-y-3">
                                                        <div className="relative aspect-video rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 flex items-center justify-center bg-slate-50 dark:bg-slate-800/50 overflow-hidden">
                                                            {block.imageUrl ? (
                                                                <>
                                                                    <img src={block.imageUrl} alt="プレビュー" className="w-full h-full object-contain" />
                                                                    <div className="absolute inset-0 bg-black/50 opacity-0 hover:opacity-100 flex items-center justify-center transition-opacity">
                                                                        <label className="cursor-pointer px-4 py-2 bg-white text-slate-900 rounded-lg text-sm font-medium hover:bg-slate-50">
                                                                            変更する
                                                                            <input
                                                                                type="file"
                                                                                accept="image/jpeg,image/png"
                                                                                className="hidden"
                                                                                onChange={(e) => {
                                                                                    const file = e.target.files?.[0]
                                                                                    if (file) handleFileUpload(index, blockIndex, file, 'image')
                                                                                }}
                                                                            />
                                                                        </label>
                                                                    </div>
                                                                </>
                                                            ) : (
                                                                <label className="cursor-pointer flex flex-col items-center p-6 w-full h-full justify-center">
                                                                    {uploadingStepIndex === index && uploadingBlockIndex === blockIndex ? (
                                                                        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                                                                    ) : (
                                                                        <>
                                                                            <ImageIcon className="w-8 h-8 text-slate-400 mb-2" />
                                                                            <span className="text-sm font-medium text-blue-600">画像を選択</span>
                                                                            <span className="text-xs text-slate-500 mt-1">JPEG/PNG, 10MB以下</span>
                                                                        </>
                                                                    )}
                                                                    <input
                                                                        type="file"
                                                                        accept="image/jpeg,image/png"
                                                                        className="hidden"
                                                                        onChange={(e) => {
                                                                            const file = e.target.files?.[0]
                                                                            if (file) handleFileUpload(index, blockIndex, file, 'image')
                                                                        }}
                                                                    />
                                                                </label>
                                                            )}
                                                        </div>
                                                        {block.imageUrl && (
                                                            <div className="bg-slate-50 dark:bg-slate-800/50 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                                                                <Label className="text-xs mb-2 block">タップ時のアクション (オプション)</Label>
                                                                <div className="space-y-2">
                                                                    <Input
                                                                        placeholder="URL (http://...)"
                                                                        value={block.customActions?.redirectUrl || ''}
                                                                        onChange={(e) => updateBlock(index, blockIndex, {
                                                                            customActions: { ...block.customActions, redirectUrl: e.target.value }
                                                                        })}
                                                                        className="text-sm h-8"
                                                                    />
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}

                                                {block.type === 'video' && (
                                                    <div className="relative aspect-video rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 flex items-center justify-center bg-slate-50 dark:bg-slate-800/50 overflow-hidden">
                                                        {block.videoUrl ? (
                                                            <>
                                                                <video src={block.videoUrl} className="w-full h-full object-contain" controls />
                                                                <div className="absolute top-2 right-2">
                                                                    <label className="cursor-pointer px-3 py-1 bg-white/90 text-slate-900 rounded shadow text-xs font-medium hover:bg-white">
                                                                        変更
                                                                        <input
                                                                            type="file"
                                                                            accept="video/mp4"
                                                                            className="hidden"
                                                                            onChange={(e) => {
                                                                                const file = e.target.files?.[0]
                                                                                if (file) handleFileUpload(index, blockIndex, file, 'video')
                                                                            }}
                                                                        />
                                                                    </label>
                                                                </div>
                                                            </>
                                                        ) : (
                                                            <label className="cursor-pointer flex flex-col items-center p-6 w-full h-full justify-center">
                                                                {uploadingStepIndex === index && uploadingBlockIndex === blockIndex ? (
                                                                    <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                                                                ) : (
                                                                    <>
                                                                        <Video className="w-8 h-8 text-slate-400 mb-2" />
                                                                        <span className="text-sm font-medium text-blue-600">動画を選択</span>
                                                                        <span className="text-xs text-slate-500 mt-1">MP4, 200MB以下</span>
                                                                    </>
                                                                )}
                                                                <input
                                                                    type="file"
                                                                    accept="video/mp4"
                                                                    className="hidden"
                                                                    onChange={(e) => {
                                                                        const file = e.target.files?.[0]
                                                                        if (file) handleFileUpload(index, blockIndex, file, 'video')
                                                                    }}
                                                                />
                                                            </label>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ))}

                                        {step.blocks.length < 5 && (
                                            <div className="flex gap-2 border-t border-slate-200 dark:border-slate-700 pt-3 mt-2">
                                                <Button type="button" variant="outline" size="sm" onClick={() => addBlock(index, 'text')} className="flex-1">
                                                    <Type className="w-4 h-4 mr-1" />テキスト
                                                </Button>
                                                <Button type="button" variant="outline" size="sm" onClick={() => addBlock(index, 'image')} className="flex-1">
                                                    <ImageIcon className="w-4 h-4 mr-1" />画像
                                                </Button>
                                                <Button type="button" variant="outline" size="sm" onClick={() => addBlock(index, 'video')} className="flex-1">
                                                    <Video className="w-4 h-4 mr-1" />動画
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="flex gap-2 justify-end">
                            <Button variant="outline" onClick={resetForm}>
                                キャンセル
                            </Button>
                            <Button
                                onClick={handleSave}
                                disabled={saving || !formName.trim() || formSteps.some(s => !isStepValid(s))}
                            >
                                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                                <Save className="w-4 h-4" />
                                保存
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* シナリオ一覧 */}
            <div className="space-y-4">
                {scenarios.map(scenario => (
                    <Card key={scenario.id} className="overflow-hidden">
                        <CardContent className="p-0">
                            {/* ヘッダー */}
                            <div
                                className="p-4 flex items-center justify-between cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                                onClick={() => setExpandedScenario(expandedScenario === scenario.id ? null : scenario.id)}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={cn(
                                        "w-10 h-10 rounded-xl flex items-center justify-center",
                                        scenario.is_active
                                            ? "bg-gradient-to-br from-emerald-500 to-green-600 text-white"
                                            : "bg-slate-200 dark:bg-slate-700 text-slate-500"
                                    )}>
                                        <MessageCircle className="w-5 h-5" />
                                    </div>
                                    <div>
                                        <h3 className="font-medium">{scenario.name}</h3>
                                        <div className="flex items-center gap-2 text-sm text-slate-500">
                                            {scenario.trigger_type === 'follow' ? (
                                                <span>友だち追加時</span>
                                            ) : (
                                                <span className="flex items-center gap-1">
                                                    <TagIcon className="w-3 h-3" />
                                                    {scenario.trigger_tag?.name || 'タグ付与時'}
                                                </span>
                                            )}
                                            <span>•</span>
                                            <span>{scenario.step_messages.length}ステップ</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={(e) => { e.stopPropagation(); openManualStart(scenario) }}
                                        className="p-2 hover:bg-blue-50 text-blue-600 rounded-lg transition-colors"
                                        title="手動で配信開始"
                                    >
                                        <Rocket className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); toggleActive(scenario.id, scenario.is_active) }}
                                        className={cn(
                                            "p-2 rounded-lg transition-colors",
                                            scenario.is_active
                                                ? "hover:bg-emerald-50 text-emerald-600"
                                                : "hover:bg-slate-100 text-slate-400"
                                        )}
                                    >
                                        {scenario.is_active ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                                    </button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); startEditing(scenario) }}
                                        className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                                    >
                                        <Edit2 className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); handleDelete(scenario.id) }}
                                        className="p-2 hover:bg-red-50 text-red-500 rounded-lg transition-colors"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                    {expandedScenario === scenario.id ? (
                                        <ChevronUp className="w-5 h-5 text-slate-400" />
                                    ) : (
                                        <ChevronDown className="w-5 h-5 text-slate-400" />
                                    )}
                                </div>
                            </div>

                            {/* ステップ詳細 */}
                            {expandedScenario === scenario.id && (
                                <div className="px-4 pb-4 space-y-2 border-t border-slate-100 dark:border-slate-800">
                                    <div className="pt-4 text-sm text-slate-500">ステップ詳細</div>
                                    {scenario.step_messages.map((step, index) => (
                                        <div key={step.id} className="flex items-start gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                                            <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 flex items-center justify-center text-sm font-medium">
                                                {index + 1}
                                            </div>
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                                                    <Clock className="w-3 h-3" />
                                                    {formatDelayMinutes(step.delay_minutes, step.send_hour, step.send_minute)}
                                                </div>
                                                <p className="text-sm line-clamp-2">
                                                    {(() => {
                                                        const raw = Array.isArray(step.content) ? step.content[0] : step.content
                                                        if (!raw) return '（メッセージなし）'
                                                        if (raw.type === 'text') return raw.text || 'テキストメッセージ'
                                                        if (raw.type === 'image') return '📷 画像メッセージ'
                                                        if (raw.type === 'video') return '🎬 動画メッセージ'
                                                        return 'リッチメッセージ'
                                                    })()}
                                                </p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                ))}
            </div>

            {scenarios.length === 0 && !isCreating && (
                <div className="text-center py-12">
                    <div className="w-16 h-16 mx-auto mb-4 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center">
                        <MessageCircle className="w-8 h-8 text-slate-400" />
                    </div>
                    <p className="text-slate-500 mb-4">
                        ステップ配信シナリオがありません
                    </p>
                    <Button onClick={startCreating}>
                        最初のシナリオを作成
                    </Button>
                </div>
            )}

            {/* 手動開始モーダル */}
            {manualStartScenario && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto shadow-2xl">
                        <div className="p-6 space-y-5">
                            <div className="flex items-center justify-between">
                                <h2 className="text-lg font-bold flex items-center gap-2">
                                    <Rocket className="w-5 h-5 text-blue-600" />
                                    配信開始
                                </h2>
                                <button onClick={closeManualStart} className="p-2 hover:bg-slate-100 rounded-lg">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                                <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                                    {manualStartScenario.name}
                                </p>
                                <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                                    {manualStartScenario.step_messages.length}ステップ
                                </p>
                            </div>

                            {/* 開始ステップ */}
                            <div className="space-y-2">
                                <Label>開始ステップ</Label>
                                <select
                                    value={manualStartStep}
                                    onChange={(e) => setManualStartStep(parseInt(e.target.value))}
                                    className="w-full h-10 px-3 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
                                >
                                    {manualStartScenario.step_messages.map((sm, i) => (
                                        <option key={sm.id} value={sm.step_order}>
                                            ステップ {sm.step_order}: {formatDelayMinutes(sm.delay_minutes, sm.send_hour, sm.send_minute)} — {
                                                (() => {
                                                    const raw = Array.isArray(sm.content) ? sm.content[0] : sm.content;
                                                    if (!raw) return '（メッセージなし）';
                                                    if (raw.type === 'text') return (raw.text || '').substring(0, 30);
                                                    if (raw.type === 'image') return '📷 画像';
                                                    if (raw.type === 'video') return '🎬 動画';
                                                    return 'リッチメッセージ';
                                                })()
                                            }
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* 対象タイプ */}
                            <div className="space-y-2">
                                <Label>対象</Label>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setManualTargetType('users')}
                                        className={cn(
                                            "flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors",
                                            manualTargetType === 'users'
                                                ? "bg-blue-600 text-white"
                                                : "bg-slate-100 dark:bg-slate-800 hover:bg-slate-200"
                                        )}
                                    >
                                        <Users className="w-4 h-4 inline mr-1" />
                                        友だち選択
                                    </button>
                                    <button
                                        onClick={() => setManualTargetType('tag')}
                                        className={cn(
                                            "flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors",
                                            manualTargetType === 'tag'
                                                ? "bg-blue-600 text-white"
                                                : "bg-slate-100 dark:bg-slate-800 hover:bg-slate-200"
                                        )}
                                    >
                                        <TagIcon className="w-4 h-4 inline mr-1" />
                                        タグ選択
                                    </button>
                                </div>
                            </div>

                            {/* 友だち選択 */}
                            {manualTargetType === 'users' && (
                                <div className="space-y-2">
                                    <div className="relative">
                                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                        <input
                                            type="text"
                                            value={manualSearchQuery}
                                            onChange={(e) => setManualSearchQuery(e.target.value)}
                                            placeholder="友だちを検索..."
                                            className="w-full h-10 pl-10 pr-3 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
                                        />
                                    </div>

                                    {loadingUsers ? (
                                        <div className="flex justify-center py-4">
                                            <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
                                        </div>
                                    ) : (
                                        <>
                                            <div className="flex items-center justify-between text-xs text-slate-500">
                                                <span>{manualSelectedUsers.length}人を選択中</span>
                                                <button
                                                    onClick={selectAllFilteredUsers}
                                                    className="text-blue-600 hover:underline"
                                                >
                                                    表示中を全選択/解除
                                                </button>
                                            </div>
                                            <div className="max-h-48 overflow-y-auto space-y-1 border border-slate-200 dark:border-slate-700 rounded-lg p-1">
                                                {filteredUsers.map(user => (
                                                    <label
                                                        key={user.id}
                                                        className={cn(
                                                            "flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors",
                                                            manualSelectedUsers.includes(user.id)
                                                                ? "bg-blue-50 dark:bg-blue-900/20"
                                                                : "hover:bg-slate-50 dark:hover:bg-slate-800"
                                                        )}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={manualSelectedUsers.includes(user.id)}
                                                            onChange={() => toggleUserSelection(user.id)}
                                                            className="w-4 h-4 rounded text-blue-600"
                                                        />
                                                        {user.picture_url && (
                                                            <img src={user.picture_url} alt="" className="w-7 h-7 rounded-full" />
                                                        )}
                                                        <span className="text-sm truncate">{user.display_name || '名前なし'}</span>
                                                    </label>
                                                ))}
                                                {filteredUsers.length === 0 && (
                                                    <p className="text-sm text-slate-400 text-center py-4">該当する友だちが見つかりません</p>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}

                            {/* タグ選択 */}
                            {manualTargetType === 'tag' && (
                                <div className="space-y-2">
                                    <Label>対象タグ</Label>
                                    <select
                                        value={manualTagId || ''}
                                        onChange={(e) => setManualTagId(e.target.value || null)}
                                        className="w-full h-10 px-3 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
                                    >
                                        <option value="">タグを選択</option>
                                        {tags.map(tag => (
                                            <option key={tag.id} value={tag.id}>{tag.name}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {/* 結果メッセージ */}
                            {manualResult && (
                                <div className={cn(
                                    "p-3 rounded-lg text-sm",
                                    manualResult.startsWith('エラー')
                                        ? "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300"
                                        : "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300"
                                )}>
                                    {manualResult}
                                </div>
                            )}

                            {/* 開始ボタン */}
                            <div className="flex gap-2 justify-end">
                                <Button variant="outline" onClick={closeManualStart}>
                                    閉じる
                                </Button>
                                <Button
                                    onClick={handleManualStart}
                                    disabled={
                                        manualStarting ||
                                        (manualTargetType === 'users' && manualSelectedUsers.length === 0) ||
                                        (manualTargetType === 'tag' && !manualTagId)
                                    }
                                    className="bg-blue-600 hover:bg-blue-700"
                                >
                                    {manualStarting && <Loader2 className="w-4 h-4 animate-spin" />}
                                    <Rocket className="w-4 h-4" />
                                    配信開始
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
