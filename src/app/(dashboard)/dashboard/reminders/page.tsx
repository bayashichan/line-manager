'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { cn, getCookie } from '@/lib/utils'
import { uploadToR2 } from '@/lib/storage/upload-client'
import { describeReminderTiming, formatJstDateTime } from '@/lib/reminders/timing'
import type { MessageContent, Reminder, ReminderStep, ReminderTimingType } from '@/types'
import {
    BellRing,
    Plus,
    X,
    Trash2,
    Loader2,
    Type,
    Image as ImageIcon,
    Upload,
    Pencil,
    UserPlus,
} from 'lucide-react'

type Block = { type: 'text' | 'image'; text?: string; imageUrl?: string }

type FormStep = {
    timingType: ReminderTimingType
    offsetDays: number
    time: string // "HH:MM"
    amount: number
    unit: 'minutes' | 'hours'
    direction: 'before' | 'after'
    blocks: Block[]
}

type ReminderWithSteps = Reminder & { reminder_steps: ReminderStep[] }

type RegisteredRow = {
    id: string
    target_at: string
    label: string | null
    status: string
    source: string
    line_users: { display_name: string | null; internal_name: string | null } | null
    reminders: { name: string } | null
    reminder_deliveries: { status: string; send_at: string }[]
}

const DAY_OPTIONS = [-14, -10, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 7]

const dayLabel = (d: number) => (d === 0 ? '当日' : d === -1 ? '前日' : d === 1 ? '翌日' : d < 0 ? `${-d}日前` : `${d}日後`)

const newStep = (): FormStep => ({
    timingType: 'day_time',
    offsetDays: -1,
    time: '20:00',
    amount: 1,
    unit: 'hours',
    direction: 'before',
    blocks: [{ type: 'text', text: '' }],
})

export default function RemindersPage() {
    const [channelId, setChannelId] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [reminders, setReminders] = useState<ReminderWithSteps[]>([])
    const [registered, setRegistered] = useState<RegisteredRow[]>([])

    // テンプレートの編集
    const [editing, setEditing] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [fName, setFName] = useState('')
    const [fActive, setFActive] = useState(true)
    const [fSendMissed, setFSendMissed] = useState(true)
    const [fSteps, setFSteps] = useState<FormStep[]>([newStep()])
    const [saving, setSaving] = useState(false)
    const [uploading, setUploading] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    // 友だちへの登録
    const [regReminderId, setRegReminderId] = useState('')
    const [regQuery, setRegQuery] = useState('')
    const [regFriends, setRegFriends] = useState<{ id: string; display_name: string | null; internal_name: string | null }[]>([])
    const [regFriend, setRegFriend] = useState<{ id: string; name: string } | null>(null)
    const [regDate, setRegDate] = useState('')
    const [regTime, setRegTime] = useState('10:00')
    const [regLabel, setRegLabel] = useState('')
    const [registering, setRegistering] = useState(false)
    const [regMessage, setRegMessage] = useState<string | null>(null)

    useEffect(() => {
        init()
    }, [])

    const init = async () => {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return
        const saved = getCookie('line-manager-channel-id')
        let query = supabase.from('channel_members').select('channel_id').eq('profile_id', user.id)
        query = saved ? query.eq('channel_id', saved) : query.limit(1)
        const { data } = await query
        if (data && data.length > 0) {
            setChannelId(data[0].channel_id)
            await fetchData(data[0].channel_id)
        }
        setLoading(false)
    }

    const fetchData = async (id: string) => {
        const supabase = createClient()
        const [{ data: rs }, { data: regs }] = await Promise.all([
            supabase.from('reminders').select('*, reminder_steps(*)').eq('channel_id', id).order('created_at'),
            supabase
                .from('friend_reminders')
                .select('id, target_at, label, status, source, line_users(display_name, internal_name), reminders(name), reminder_deliveries(status, send_at)')
                .eq('channel_id', id)
                .eq('status', 'active')
                .order('target_at')
                .limit(200),
        ])
        setReminders(((rs ?? []) as ReminderWithSteps[]).map(r => ({
            ...r,
            reminder_steps: [...(r.reminder_steps ?? [])].sort((a, b) => a.step_order - b.step_order),
        })))
        setRegistered((regs ?? []) as unknown as RegisteredRow[])
    }

    // ---------------------------------------------------------------- テンプレート編集
    const resetForm = () => {
        setEditing(false)
        setEditingId(null)
        setFName('')
        setFActive(true)
        setFSendMissed(true)
        setFSteps([newStep()])
        setError(null)
    }

    const startEdit = (r: ReminderWithSteps) => {
        setEditingId(r.id)
        setFName(r.name)
        setFActive(r.is_active)
        setFSendMissed(r.send_missed)
        setFSteps(r.reminder_steps.length > 0 ? r.reminder_steps.map(toFormStep) : [newStep()])
        setEditing(true)
        setError(null)
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    const toFormStep = (s: ReminderStep): FormStep => ({
        timingType: s.timing_type,
        offsetDays: s.offset_days,
        time: s.send_hour === null ? '' : `${String(s.send_hour).padStart(2, '0')}:${String(s.send_minute).padStart(2, '0')}`,
        amount: s.offset_minutes % 60 === 0 && s.offset_minutes !== 0 ? Math.abs(s.offset_minutes) / 60 : Math.abs(s.offset_minutes),
        unit: s.offset_minutes % 60 === 0 && s.offset_minutes !== 0 ? 'hours' : 'minutes',
        direction: s.offset_minutes > 0 ? 'after' : 'before',
        blocks: (s.content ?? []).map(b => b.type === 'image'
            ? { type: 'image' as const, imageUrl: b.originalContentUrl || b.previewImageUrl }
            : { type: 'text' as const, text: b.text || '' }),
    })

    const updateStep = (index: number, patch: Partial<FormStep>) => {
        setFSteps(steps => steps.map((s, i) => (i === index ? { ...s, ...patch } : s)))
    }

    const updateBlock = (stepIndex: number, blockIndex: number, patch: Partial<Block>) => {
        setFSteps(steps => steps.map((s, i) => i !== stepIndex ? s : {
            ...s,
            blocks: s.blocks.map((b, j) => (j === blockIndex ? { ...b, ...patch } : b)),
        }))
    }

    const uploadImage = async (stepIndex: number, blockIndex: number, file: File) => {
        if (!channelId) return
        setUploading(`${stepIndex}-${blockIndex}`)
        try {
            const url = await uploadToR2(file, channelId, { prefix: 'reminders', compress: true })
            updateBlock(stepIndex, blockIndex, { imageUrl: url })
        } catch (err) {
            alert(`画像のアップロードに失敗しました: ${err instanceof Error ? err.message : err}`)
        } finally {
            setUploading(null)
        }
    }

    const stepTiming = (s: FormStep) => {
        const [h, m] = s.time ? s.time.split(':').map(Number) : [null, 0]
        const minutes = s.amount * (s.unit === 'hours' ? 60 : 1)
        return {
            timing_type: s.timingType,
            offset_days: s.timingType === 'day_time' ? s.offsetDays : 0,
            send_hour: s.timingType === 'day_time' && h !== null && !Number.isNaN(h) ? h : null,
            send_minute: s.timingType === 'day_time' && typeof m === 'number' && !Number.isNaN(m) ? m : 0,
            offset_minutes: s.timingType === 'relative' ? (s.direction === 'before' ? -minutes : minutes) : 0,
        }
    }

    const toContent = (blocks: Block[]): MessageContent[] => blocks
        .filter(b => (b.type === 'text' ? b.text?.trim() : b.imageUrl))
        .map(b => b.type === 'text'
            ? { type: 'text', text: b.text!.trim() }
            : { type: 'image', originalContentUrl: b.imageUrl, previewImageUrl: b.imageUrl })

    const save = async () => {
        if (!channelId) return
        setError(null)
        if (!fName.trim()) return setError('名前を入力してください')
        const steps = fSteps.map((s, i) => ({ step_order: i + 1, ...stepTiming(s), content: toContent(s.blocks) }))
        const empty = steps.findIndex(s => s.content.length === 0)
        if (empty >= 0) return setError(`メッセージ${empty + 1}の内容を入力してください`)
        if (steps.some(s => s.content.length > 5)) return setError('1つのメッセージに入れられる吹き出しは5つまでです')

        setSaving(true)
        const supabase = createClient()
        try {
            let reminderId = editingId
            if (reminderId) {
                const { error: e } = await supabase.from('reminders')
                    .update({ name: fName.trim(), is_active: fActive, send_missed: fSendMissed, updated_at: new Date().toISOString() })
                    .eq('id', reminderId)
                if (e) throw e
                const { error: d } = await supabase.from('reminder_steps').delete().eq('reminder_id', reminderId)
                if (d) throw d
            } else {
                const { data, error: e } = await supabase.from('reminders')
                    .insert({ channel_id: channelId, name: fName.trim(), is_active: fActive, send_missed: fSendMissed })
                    .select('id').single()
                if (e || !data) throw e
                reminderId = data.id
            }
            const { error: s } = await supabase.from('reminder_steps').insert(steps.map(st => ({ ...st, reminder_id: reminderId })))
            if (s) throw s
            await fetchData(channelId)
            resetForm()
        } catch (err) {
            setError(`保存に失敗しました: ${err instanceof Error ? err.message : JSON.stringify(err)}`)
        } finally {
            setSaving(false)
        }
    }

    const remove = async (r: ReminderWithSteps) => {
        if (!channelId) return
        if (!confirm(`「${r.name}」を削除しますか？\n登録済みの予定は、登録時の内容のまま送信されます（止めたい場合は下の一覧から取り消してください）。`)) return
        const supabase = createClient()
        await supabase.from('reminders').delete().eq('id', r.id)
        await fetchData(channelId)
    }

    // ---------------------------------------------------------------- 友だちへの登録
    const searchFriends = async (q: string) => {
        setRegQuery(q)
        if (!channelId || q.trim().length === 0) return setRegFriends([])
        const keyword = q.replace(/[%,()*\\]/g, '').trim()
        if (!keyword) return setRegFriends([])
        const supabase = createClient()
        const { data } = await supabase
            .from('line_users')
            .select('id, display_name, internal_name')
            .eq('channel_id', channelId)
            .or(`display_name.ilike.%${keyword}%,internal_name.ilike.%${keyword}%`)
            .limit(8)
        setRegFriends(data ?? [])
    }

    const register = async () => {
        setRegMessage(null)
        if (!regReminderId || !regFriend || !regDate || !regTime) {
            return setRegMessage('リマインダー・友だち・予定の日時を入力してください')
        }
        setRegistering(true)
        try {
            const targetAt = new Date(`${regDate}T${regTime}:00+09:00`).toISOString()
            const res = await fetch('/api/reminders/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reminderId: regReminderId, lineUserId: regFriend.id, targetAt, label: regLabel }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || '登録に失敗しました')
            setRegMessage(
                `登録しました（予定どおり送信: ${data.scheduled}通 / 送信時刻を過ぎているためすぐ送信: ${data.sentNow}通 / 送らない: ${data.skipped}通）`
            )
            setRegFriend(null)
            setRegQuery('')
            setRegFriends([])
            setRegLabel('')
            if (channelId) await fetchData(channelId)
        } catch (err) {
            setRegMessage(err instanceof Error ? err.message : '登録に失敗しました')
        } finally {
            setRegistering(false)
        }
    }

    const cancelRegistered = async (row: RegisteredRow) => {
        if (!confirm('このリマインダーを取り消しますか？まだ送っていないメッセージは送られなくなります。')) return
        const res = await fetch('/api/reminders/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ friendReminderId: row.id }),
        })
        if (!res.ok) alert('取り消しに失敗しました')
        if (channelId) await fetchData(channelId)
    }

    if (loading) {
        return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-slate-400" /></div>
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                        リマインダー
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        面談などの予定の日時を基準に、「3日前」「前日」「1時間前」のように自動で送ります
                    </p>
                </div>
                {!editing && (
                    <Button onClick={() => { resetForm(); setEditing(true) }}>
                        <Plus className="w-4 h-4" />
                        新規作成
                    </Button>
                )}
            </div>

            <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg text-sm text-slate-600 dark:text-slate-300 space-y-1">
                <p>文面では次の差し込みが使えます: <code>{'{name}'}</code> 友だちの名前 / <code>{'{日時}'}</code> 例: 10月3日(土) 10:00 / <code>{'{日付}'}</code> / <code>{'{時刻}'}</code> / <code>{'{予定}'}</code> 予定の名前</p>
                <p>送信は LINE のプッシュメッセージなので、1通ごとに月の送信枠を消費します。</p>
            </div>

            {editing && (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>{editingId ? 'リマインダーを編集' : 'リマインダーを作成'}</CardTitle>
                        <button onClick={resetForm} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"><X className="w-5 h-5" /></button>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="space-y-2">
                            <Label>名前（管理用）*</Label>
                            <Input value={fName} onChange={e => setFName(e.target.value)} placeholder="例: 初回無料面談の事前案内" />
                        </div>
                        <div className="flex flex-col gap-2 text-sm">
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={fActive} onChange={e => setFActive(e.target.checked)} />
                                有効（オフにすると新しく登録できなくなります。登録済みの予定は送られます）
                            </label>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={fSendMissed} onChange={e => setFSendMissed(e.target.checked)} />
                                登録した時点で送信時刻を過ぎているメッセージは、予定の前ならすぐ送る
                            </label>
                        </div>

                        {fSteps.map((step, i) => (
                            <div key={i} className="rounded-lg border p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <p className="font-medium">メッセージ {i + 1}</p>
                                    {fSteps.length > 1 && (
                                        <button onClick={() => setFSteps(fSteps.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500">
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>

                                <div className="flex flex-wrap items-center gap-2 text-sm">
                                    <select
                                        className="border rounded-md px-2 py-1.5 bg-background"
                                        value={step.timingType}
                                        onChange={e => updateStep(i, { timingType: e.target.value as ReminderTimingType })}
                                    >
                                        <option value="day_time">日にちと時刻で指定</option>
                                        <option value="relative">予定の何時間前・何分前</option>
                                    </select>
                                    {step.timingType === 'day_time' ? (
                                        <>
                                            <select
                                                className="border rounded-md px-2 py-1.5 bg-background"
                                                value={step.offsetDays}
                                                onChange={e => updateStep(i, { offsetDays: Number(e.target.value) })}
                                            >
                                                {DAY_OPTIONS.map(d => <option key={d} value={d}>{dayLabel(d)}</option>)}
                                            </select>
                                            <Input type="time" className="w-32" value={step.time} onChange={e => updateStep(i, { time: e.target.value })} />
                                        </>
                                    ) : (
                                        <>
                                            <Input type="number" min={1} className="w-24" value={step.amount}
                                                onChange={e => updateStep(i, { amount: Math.max(1, Number(e.target.value) || 1) })} />
                                            <select className="border rounded-md px-2 py-1.5 bg-background" value={step.unit}
                                                onChange={e => updateStep(i, { unit: e.target.value as FormStep['unit'] })}>
                                                <option value="minutes">分</option>
                                                <option value="hours">時間</option>
                                            </select>
                                            <select className="border rounded-md px-2 py-1.5 bg-background" value={step.direction}
                                                onChange={e => updateStep(i, { direction: e.target.value as FormStep['direction'] })}>
                                                <option value="before">前</option>
                                                <option value="after">後</option>
                                            </select>
                                        </>
                                    )}
                                    <span className="text-slate-500">→ {describeReminderTiming(stepTiming(step))}</span>
                                </div>

                                {step.blocks.map((block, j) => (
                                    <div key={j} className="flex gap-2 items-start">
                                        <div className="flex-1">
                                            {block.type === 'text' ? (
                                                <Textarea
                                                    rows={4}
                                                    value={block.text ?? ''}
                                                    onChange={e => updateBlock(i, j, { text: e.target.value })}
                                                    placeholder="例: {name}さん、{日時}の面談の前に、次の質問にお答えください。"
                                                />
                                            ) : (
                                                <div className="flex items-center gap-3">
                                                    {block.imageUrl ? (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <img src={block.imageUrl} alt="" className="w-24 h-24 object-cover rounded" />
                                                    ) : (
                                                        <label className="flex items-center gap-2 px-3 py-2 border rounded-md cursor-pointer text-sm">
                                                            {uploading === `${i}-${j}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                                                            画像を選ぶ
                                                            <input type="file" accept="image/*" className="hidden"
                                                                onChange={e => e.target.files?.[0] && uploadImage(i, j, e.target.files[0])} />
                                                        </label>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        {step.blocks.length > 1 && (
                                            <button onClick={() => updateStep(i, { blocks: step.blocks.filter((_, k) => k !== j) })}
                                                className="text-slate-400 hover:text-red-500 mt-2"><X className="w-4 h-4" /></button>
                                        )}
                                    </div>
                                ))}
                                {step.blocks.length < 5 && (
                                    <div className="flex gap-2">
                                        <Button variant="outline" size="sm" onClick={() => updateStep(i, { blocks: [...step.blocks, { type: 'text', text: '' }] })}>
                                            <Type className="w-4 h-4 mr-1" />テキストを追加
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={() => updateStep(i, { blocks: [...step.blocks, { type: 'image' }] })}>
                                            <ImageIcon className="w-4 h-4 mr-1" />画像を追加
                                        </Button>
                                    </div>
                                )}
                            </div>
                        ))}

                        <Button variant="outline" onClick={() => setFSteps([...fSteps, newStep()])}>
                            <Plus className="w-4 h-4 mr-1" />メッセージを追加
                        </Button>

                        {error && <p className="text-sm text-red-600">{error}</p>}
                        <div className="flex gap-2">
                            <Button onClick={save} disabled={saving}>{saving && <Loader2 className="w-4 h-4 animate-spin" />}保存</Button>
                            <Button variant="outline" onClick={resetForm}>キャンセル</Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* テンプレート一覧 */}
            <div className="grid gap-4">
                {reminders.length === 0 && !editing && (
                    <Card><CardContent className="py-10 text-center text-slate-500">
                        <BellRing className="w-8 h-8 mx-auto mb-2 opacity-50" />
                        まだリマインダーがありません。「新規作成」から作りましょう。
                    </CardContent></Card>
                )}
                {reminders.map(r => (
                    <Card key={r.id}>
                        <CardContent className="py-4 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                    <p className="font-medium">{r.name}</p>
                                    <span className={cn('text-xs px-2 py-0.5 rounded-full',
                                        r.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
                                        {r.is_active ? '有効' : '停止中'}
                                    </span>
                                </div>
                                <div className="flex gap-1">
                                    <Button variant="ghost" size="sm" onClick={() => startEdit(r)}><Pencil className="w-4 h-4" /></Button>
                                    <Button variant="ghost" size="sm" onClick={() => remove(r)}><Trash2 className="w-4 h-4" /></Button>
                                </div>
                            </div>
                            <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1">
                                {r.reminder_steps.map(s => (
                                    <li key={s.id} className="flex gap-2">
                                        <span className="shrink-0 w-28 text-slate-500">{describeReminderTiming(s)}</span>
                                        <span className="truncate">{(s.content ?? []).map(b => b.type === 'text' ? b.text : '［画像］').join(' / ')}</span>
                                    </li>
                                ))}
                            </ul>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* 友だちに登録 */}
            <Card>
                <CardHeader><CardTitle className="flex items-center gap-2"><UserPlus className="w-5 h-5" />友だちに登録する</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                    <p className="text-slate-500">面談の日程調整で確定した人には自動で登録されます。ここでは手動で登録できます。</p>
                    <div className="grid sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                            <Label>リマインダー</Label>
                            <select className="w-full border rounded-md px-2 py-2 bg-background" value={regReminderId} onChange={e => setRegReminderId(e.target.value)}>
                                <option value="">選んでください</option>
                                {reminders.filter(r => r.is_active).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                            </select>
                        </div>
                        <div className="space-y-1 relative">
                            <Label>友だち</Label>
                            {regFriend ? (
                                <div className="flex items-center gap-2 border rounded-md px-3 py-2">
                                    <span className="flex-1">{regFriend.name}</span>
                                    <button onClick={() => setRegFriend(null)}><X className="w-4 h-4" /></button>
                                </div>
                            ) : (
                                <>
                                    <Input value={regQuery} onChange={e => searchFriends(e.target.value)} placeholder="名前で検索" />
                                    {regFriends.length > 0 && (
                                        <div className="absolute z-10 w-full bg-background border rounded-md shadow mt-1">
                                            {regFriends.map(f => (
                                                <button key={f.id} className="block w-full text-left px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800"
                                                    onClick={() => { setRegFriend({ id: f.id, name: f.internal_name || f.display_name || '（名前なし）' }); setRegFriends([]) }}>
                                                    {f.display_name}{f.internal_name ? `（${f.internal_name}）` : ''}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                        <div className="space-y-1">
                            <Label>予定の日時（日本時間）</Label>
                            <div className="flex gap-2">
                                <Input type="date" value={regDate} onChange={e => setRegDate(e.target.value)} />
                                <Input type="time" className="w-32" value={regTime} onChange={e => setRegTime(e.target.value)} />
                            </div>
                        </div>
                        <div className="space-y-1">
                            <Label>予定の名前（任意・{'{予定}'} に入ります）</Label>
                            <Input value={regLabel} onChange={e => setRegLabel(e.target.value)} placeholder="例: 初回無料面談" />
                        </div>
                    </div>
                    <Button onClick={register} disabled={registering}>{registering && <Loader2 className="w-4 h-4 animate-spin" />}登録する</Button>
                    {regMessage && <p className="text-slate-600 dark:text-slate-300">{regMessage}</p>}
                </CardContent>
            </Card>

            {/* 登録済み */}
            <Card>
                <CardHeader><CardTitle>登録済みの予定（送信待ち）</CardTitle></CardHeader>
                <CardContent>
                    {registered.length === 0 ? (
                        <p className="text-sm text-slate-500">送信待ちの予定はありません。</p>
                    ) : (
                        <div className="divide-y text-sm">
                            {registered.map(row => {
                                const pending = row.reminder_deliveries.filter(d => d.status === 'pending').sort((a, b) => a.send_at.localeCompare(b.send_at))
                                const sent = row.reminder_deliveries.filter(d => d.status === 'sent').length
                                const failed = row.reminder_deliveries.filter(d => d.status === 'failed').length
                                return (
                                    <div key={row.id} className="py-3 flex flex-col sm:flex-row sm:items-center gap-2">
                                        <div className="flex-1">
                                            <p className="font-medium">
                                                {row.line_users?.internal_name || row.line_users?.display_name || '（名前なし）'}
                                                <span className="ml-2 text-slate-500 font-normal">{row.label || row.reminders?.name}</span>
                                            </p>
                                            <p className="text-slate-500">
                                                予定: {formatJstDateTime(new Date(row.target_at))}
                                                {pending[0] && ` ／ 次の送信: ${formatJstDateTime(new Date(pending[0].send_at))}`}
                                                {` ／ 送信済み ${sent}通・残り ${pending.length}通`}
                                                {failed > 0 && <span className="text-red-600">{` ・失敗 ${failed}通`}</span>}
                                                {row.source === 'booking' && ' ／ 日程調整から登録'}
                                            </p>
                                        </div>
                                        <Button variant="outline" size="sm" onClick={() => cancelRegistered(row)}>取り消す</Button>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
