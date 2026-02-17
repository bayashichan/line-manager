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
} from 'lucide-react'

interface StepScenarioWithMessages extends StepScenario {
    step_messages: StepMessage[]
    trigger_tag?: Tag
}

interface FormStep {
    delayDays: number
    sendHour: number | null
    content: string
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
        { delayDays: 0, sendHour: null, content: '' }
    ])

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

        // シナリオ一覧取得
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
            // step_messagesをstep_order順にソート
            const sorted = scenariosData.map(s => ({
                ...s,
                step_messages: (s.step_messages || []).sort((a: StepMessage, b: StepMessage) => a.step_order - b.step_order)
            }))
            setScenarios(sorted as StepScenarioWithMessages[])
        }

        // タグ一覧取得
        const { data: tagsData } = await supabase
            .from('tags')
            .select('*')
            .eq('channel_id', channelId)
            .order('name')

        if (tagsData) {
            setTags(tagsData)
        }
    }

    // delay_minutesから日数に変換
    const minutesToDays = (minutes: number): number => Math.floor(minutes / 1440)

    const resetForm = () => {
        setFormName('')
        setFormTriggerType('follow')
        setFormTriggerTagId(null)
        setFormSteps([{ delayDays: 0, sendHour: null, content: '' }])
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
        setFormSteps(
            scenario.step_messages.map(sm => ({
                delayDays: minutesToDays(sm.delay_minutes),
                sendHour: sm.send_hour ?? null,
                content: (sm.content as any)?.[0]?.text || '',
            }))
        )
        setIsCreating(false)
    }

    const addStep = () => {
        setFormSteps([...formSteps, { delayDays: 1, sendHour: 10, content: '' }]) // デフォルト1日後の10:00
    }

    const removeStep = (index: number) => {
        if (formSteps.length === 1) return
        setFormSteps(formSteps.filter((_, i) => i !== index))
    }

    const updateStep = (index: number, field: keyof FormStep, value: any) => {
        const updated = [...formSteps]
        updated[index] = { ...updated[index], [field]: value }
        // 「即時」を選んだ場合、sendHourをnullに
        if (field === 'delayDays' && value === 0) {
            updated[index].sendHour = null
        }
        // 日数が1以上でsendHourがnullの場合、デフォルト10:00を設定
        if (field === 'delayDays' && value > 0 && updated[index].sendHour === null) {
            updated[index].sendHour = 10
        }
        setFormSteps(updated)
    }

    const handleSave = async () => {
        if (!formName.trim() || !currentChannelId || formSteps.some(s => !s.content.trim())) return

        setSaving(true)
        const supabase = createClient()

        try {
            if (editingScenario) {
                // 更新
                await supabase
                    .from('step_scenarios')
                    .update({
                        name: formName,
                        trigger_type: formTriggerType,
                        trigger_tag_id: formTriggerType === 'tag_assigned' ? formTriggerTagId : null,
                    })
                    .eq('id', editingScenario.id)

                // 既存のステップを削除
                await supabase
                    .from('step_messages')
                    .delete()
                    .eq('scenario_id', editingScenario.id)

                // 新しいステップを追加
                for (let i = 0; i < formSteps.length; i++) {
                    await supabase.from('step_messages').insert({
                        scenario_id: editingScenario.id,
                        step_order: i + 1,
                        delay_minutes: formSteps[i].delayDays * 1440,
                        send_hour: formSteps[i].sendHour,
                        content: [{ type: 'text', text: formSteps[i].content }],
                    })
                }
            } else {
                // 新規作成
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
                            content: [{ type: 'text', text: formSteps[i].content }],
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
                                                        <option key={h} value={h}>{h}:00</option>
                                                    ))}
                                                </select>
                                            </>
                                        )}
                                        <span className="text-sm text-slate-500">に配信</span>
                                    </div>
                                    <textarea
                                        value={step.content}
                                        onChange={(e) => updateStep(index, 'content', e.target.value)}
                                        placeholder="メッセージを入力..."
                                        className="w-full h-24 px-3 py-2 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-800 resize-none"
                                    />
                                </div>
                            ))}
                        </div>

                        <div className="flex gap-2 justify-end">
                            <Button variant="outline" onClick={resetForm}>
                                キャンセル
                            </Button>
                            <Button
                                onClick={handleSave}
                                disabled={saving || !formName.trim() || formSteps.some(s => !s.content.trim())}
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
                                                    {formatDelayMinutes(step.delay_minutes, step.send_hour)}
                                                </div>
                                                <p className="text-sm line-clamp-2">
                                                    {(step.content as any)?.[0]?.text || '（メッセージなし）'}
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
        </div>
    )
}
