'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { cn, getCookie } from '@/lib/utils'
import { formatJstDate, formatJstShort, formatJstTime } from '@/lib/reminders/timing'
import { buildOfferMessage, buildOfferOptions, fillBookingText } from '@/lib/booking/offer'
import type { BookingOfferStatus, BookingSettings, BookingSlot, Reminder, Tag } from '@/types'
import { CalendarCheck, Loader2, Plus, Save, Trash2 } from 'lucide-react'

const DEFAULTS: Omit<BookingSettings, 'channel_id' | 'updated_at'> = {
    is_active: false,
    trigger_keywords: ['個別'],
    offer_count: 3,
    min_lead_hours: 12,
    session_label: '初回無料面談',
    intro_text: '{name}さん、ご連絡ありがとうございます！\n初回無料面談の候補日です。ご都合のよい番号を送ってください。',
    other_label: '別の日程を希望',
    decline_label: '今回は見送る',
    booked_text: 'ありがとうございます！\n{日時} で承りました。\n当日までのご案内を順にお送りしますね。',
    other_text: '承知しました。\n別の候補をお送りしますので、少々お待ちください。',
    decline_text: '承知しました。\nまたご都合のよいときに「個別」と送ってください。',
    no_slots_text: 'ご連絡ありがとうございます！\n候補日を確認してご連絡しますので、少々お待ちください。',
    taken_text: '申し訳ありません、その枠は先に埋まってしまいました。',
    nudge_enabled: true,
    nudge_after_hours: 24,
    nudge_text: '{name}さん、面談の日程はいかがでしょうか？\n番号を送るか、下のボタンをタップするだけで大丈夫です。',
    booked_tag_id: null,
    reminder_id: null,
}

type Form = typeof DEFAULTS

type SlotRow = BookingSlot & { line_users: { display_name: string | null; internal_name: string | null } | null }

type OfferRow = {
    id: string
    status: BookingOfferStatus
    created_at: string
    responded_at: string | null
    nudged_at: string | null
    line_users: { display_name: string | null; internal_name: string | null } | null
    booking_slots: { start_at: string } | null
}

const STATUS_LABEL: Record<BookingOfferStatus, string> = {
    pending: '回答待ち',
    booked: '確定',
    other: '別日程を希望',
    declined: '見送り',
    no_slots: '空き枠なし',
    superseded: '差し替え',
    cancelled: '取り消し',
}

export default function BookingPage() {
    const [channelId, setChannelId] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [form, setForm] = useState<Form>(DEFAULTS)
    const [keywordsText, setKeywordsText] = useState('個別')
    const [tags, setTags] = useState<Tag[]>([])
    const [reminders, setReminders] = useState<Reminder[]>([])
    const [slots, setSlots] = useState<SlotRow[]>([])
    const [offers, setOffers] = useState<OfferRow[]>([])
    const [saving, setSaving] = useState(false)
    const [saveMessage, setSaveMessage] = useState<string | null>(null)

    const [slotDate, setSlotDate] = useState('')
    const [slotTimes, setSlotTimes] = useState('10:00 13:00 16:00')
    const [slotMessage, setSlotMessage] = useState<string | null>(null)

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
            await fetchAll(data[0].channel_id)
        }
        setLoading(false)
    }

    const fetchAll = async (id: string) => {
        const supabase = createClient()
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
        const [{ data: settings }, { data: t }, { data: r }] = await Promise.all([
            supabase.from('booking_settings').select('*').eq('channel_id', id).maybeSingle(),
            supabase.from('tags').select('*').eq('channel_id', id).order('name'),
            supabase.from('reminders').select('*').eq('channel_id', id).order('created_at'),
        ])
        if (settings) {
            const { channel_id: _c, updated_at: _u, ...rest } = settings as BookingSettings
            void _c; void _u
            setForm({ ...DEFAULTS, ...rest })
            setKeywordsText((rest.trigger_keywords ?? []).join(' '))
        }
        setTags((t ?? []) as Tag[])
        setReminders((r ?? []) as Reminder[])
        await fetchSlotsAndOffers(id, since)
    }

    const fetchSlotsAndOffers = async (id: string, since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()) => {
        const supabase = createClient()
        const [{ data: s }, { data: o }] = await Promise.all([
            supabase.from('booking_slots').select('*, line_users(display_name, internal_name)')
                .eq('channel_id', id).gte('start_at', since).order('start_at'),
            supabase.from('booking_offers')
                .select('id, status, created_at, responded_at, nudged_at, line_users(display_name, internal_name), booking_slots!booking_offers_booked_slot_id_fkey(start_at)')
                .eq('channel_id', id).neq('status', 'superseded').order('created_at', { ascending: false }).limit(50),
        ])
        setSlots((s ?? []) as SlotRow[])
        setOffers((o ?? []) as unknown as OfferRow[])
    }

    const update = <K extends keyof Form>(key: K, value: Form[K]) => setForm(f => ({ ...f, [key]: value }))

    const saveSettings = async () => {
        if (!channelId) return
        setSaving(true)
        setSaveMessage(null)
        const keywords = keywordsText.split(/[\s,、]+/).map(k => k.trim()).filter(Boolean)
        if (keywords.length === 0) {
            setSaving(false)
            return setSaveMessage('キーワードを1つ以上入力してください')
        }
        const supabase = createClient()
        const { error } = await supabase.from('booking_settings').upsert({
            ...form,
            trigger_keywords: keywords,
            channel_id: channelId,
            updated_at: new Date().toISOString(),
        })
        setSaving(false)
        setSaveMessage(error ? `保存に失敗しました: ${error.message}` : '保存しました')
    }

    const addSlots = async () => {
        if (!channelId) return
        setSlotMessage(null)
        const times = slotTimes.split(/[\s,、]+/).map(t => t.trim()).filter(Boolean)
        if (!slotDate || times.length === 0) return setSlotMessage('日付と時刻を入力してください')
        const bad = times.find(t => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t))
        if (bad) return setSlotMessage(`時刻の形式が正しくありません: ${bad}（例: 10:00）`)
        const rows = times.map(t => {
            const [h, m] = t.split(':')
            return { channel_id: channelId, start_at: new Date(`${slotDate}T${h.padStart(2, '0')}:${m}:00+09:00`).toISOString() }
        })
        const supabase = createClient()
        const { error } = await supabase.from('booking_slots').upsert(rows, { onConflict: 'channel_id,start_at', ignoreDuplicates: true })
        setSlotMessage(error ? `追加に失敗しました: ${error.message}` : `${rows.length}枠を追加しました（同じ日時の枠がすでにあれば、そのままにします）`)
        await fetchSlotsAndOffers(channelId)
    }

    const setSlotStatus = async (slot: SlotRow, status: 'open' | 'closed') => {
        if (!channelId) return
        const supabase = createClient()
        await supabase.from('booking_slots').update({ status }).eq('id', slot.id).neq('status', 'booked')
        await fetchSlotsAndOffers(channelId)
    }

    const deleteSlot = async (slot: SlotRow) => {
        if (!channelId || !confirm(`${formatJstShort(new Date(slot.start_at))} の枠を削除しますか？`)) return
        const supabase = createClient()
        await supabase.from('booking_slots').delete().eq('id', slot.id).neq('status', 'booked')
        await fetchSlotsAndOffers(channelId)
    }

    const cancelBooking = async (slot: SlotRow) => {
        const who = slot.line_users?.internal_name || slot.line_users?.display_name || 'この方'
        if (!channelId || !confirm(`${who} の ${formatJstShort(new Date(slot.start_at))} の予約を取り消して、空き枠に戻しますか？\n登録済みのリマインダーも止まります。相手への連絡は自動では送られません。`)) return
        const res = await fetch('/api/booking/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slotId: slot.id }),
        })
        if (!res.ok) alert('取り消しに失敗しました')
        await fetchSlotsAndOffers(channelId)
    }

    // 候補の文面のプレビュー（いまの空き枠で）
    const preview = useMemo(() => {
        const earliest = Date.now() + form.min_lead_hours * 3600 * 1000
        const open = slots
            .filter(s => s.status === 'open' && new Date(s.start_at).getTime() >= earliest)
            .slice(0, form.offer_count)
        if (open.length === 0) return fillBookingText(form.no_slots_text, { name: '山田' })
        const message = buildOfferMessage(
            fillBookingText(form.intro_text, { name: '山田' }),
            buildOfferOptions(open, { other: form.other_label, decline: form.decline_label })
        )
        return String(message.text)
    }, [slots, form])

    const slotsByDate = useMemo(() => {
        const map = new Map<string, SlotRow[]>()
        for (const slot of slots) {
            const key = formatJstDate(new Date(slot.start_at))
            map.set(key, [...(map.get(key) ?? []), slot])
        }
        return [...map.entries()]
    }, [slots])

    if (loading) {
        return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-slate-400" /></div>
    }

    const textField = (key: keyof Form, label: string, rows = 3) => (
        <div className="space-y-1">
            <Label>{label}</Label>
            <Textarea rows={rows} value={String(form[key] ?? '')} onChange={e => update(key, e.target.value as never)} />
        </div>
    )

    const needsAction = (o: OfferRow) => o.status === 'other' || o.status === 'no_slots' || (o.status === 'pending' && !!o.responded_at)

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                    面談の日程調整
                </h1>
                <p className="text-slate-500 dark:text-slate-400 mt-1">
                    「個別」と送ってきた人に、空き枠から候補を番号付きで自動返信します。番号（またはボタン）で答えると予約が確定します。
                </p>
            </div>

            <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 rounded-lg text-sm space-y-1">
                <p>候補・確定などの返信は応答（Reply）API で送るので、<strong>送信枠を消費しません</strong>。催促とリマインダーはプッシュなので1通ずつ消費します。</p>
                <p>LINE 公式アカウントの管理画面やアプリで同じキーワードに応答メッセージを設定している場合は、二重に返信しないよう、そちらをオフにしてください。</p>
            </div>

            {/* 設定 */}
            <Card>
                <CardHeader><CardTitle className="flex items-center gap-2"><CalendarCheck className="w-5 h-5" />設定</CardTitle></CardHeader>
                <CardContent className="space-y-4 text-sm">
                    <label className="flex items-center gap-2 font-medium">
                        <input type="checkbox" checked={form.is_active} onChange={e => update('is_active', e.target.checked)} />
                        自動の日程調整を使う
                    </label>

                    <div className="grid sm:grid-cols-3 gap-3">
                        <div className="space-y-1">
                            <Label>きっかけのキーワード（スペース区切り・完全一致）</Label>
                            <Input value={keywordsText} onChange={e => setKeywordsText(e.target.value)} placeholder="個別" />
                        </div>
                        <div className="space-y-1">
                            <Label>案内する候補の数</Label>
                            <Input type="number" min={1} max={10} value={form.offer_count}
                                onChange={e => update('offer_count', Math.min(10, Math.max(1, Number(e.target.value) || 1)))} />
                        </div>
                        <div className="space-y-1">
                            <Label>何時間後以降の枠を案内するか</Label>
                            <Input type="number" min={0} value={form.min_lead_hours}
                                onChange={e => update('min_lead_hours', Math.max(0, Number(e.target.value) || 0))} />
                        </div>
                    </div>

                    <div className="grid sm:grid-cols-3 gap-3">
                        <div className="space-y-1">
                            <Label>予定の名前（リマインダーの {'{予定}'}）</Label>
                            <Input value={form.session_label} onChange={e => update('session_label', e.target.value)} />
                        </div>
                        <div className="space-y-1">
                            <Label>「別の日程」の選択肢</Label>
                            <Input value={form.other_label} onChange={e => update('other_label', e.target.value)} />
                        </div>
                        <div className="space-y-1">
                            <Label>「見送る」の選択肢</Label>
                            <Input value={form.decline_label} onChange={e => update('decline_label', e.target.value)} />
                        </div>
                    </div>

                    <div className="grid sm:grid-cols-2 gap-3">
                        {textField('intro_text', '候補を送るときの文面（この下に番号付きの候補が付きます）')}
                        <div className="space-y-1">
                            <Label>プレビュー（いまの空き枠）</Label>
                            <pre className="whitespace-pre-wrap rounded-md border bg-slate-50 dark:bg-slate-900 p-3 text-xs">{preview}</pre>
                        </div>
                        {textField('booked_text', '確定したときの返信（{日時} に日時が入ります）')}
                        {textField('other_text', '「別の日程」を選んだときの返信（その後はあなたが個別に対応）')}
                        {textField('decline_text', '「見送る」を選んだときの返信')}
                        {textField('no_slots_text', '案内できる空き枠がないときの返信（その後はあなたが個別に対応）')}
                        {textField('taken_text', '選んだ枠が先に埋まったときのお詫び（このあと残りの候補を出し直します）', 2)}
                    </div>

                    <div className="rounded-lg border p-3 space-y-2">
                        <label className="flex items-center gap-2 font-medium">
                            <input type="checkbox" checked={form.nudge_enabled} onChange={e => update('nudge_enabled', e.target.checked)} />
                            返事がないときに1回だけ催促する
                        </label>
                        <div className="flex items-center gap-2">
                            <Input type="number" min={1} className="w-24" value={form.nudge_after_hours}
                                onChange={e => update('nudge_after_hours', Math.max(1, Number(e.target.value) || 24))} />
                            <span>時間たっても返事がなければ（番号以外でも何か返事があれば催促しません）</span>
                        </div>
                        {textField('nudge_text', '催促の文面（この下に候補とボタンが付きます）', 2)}
                    </div>

                    <div className="grid sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                            <Label>確定した人に付けるタグ</Label>
                            <select className="w-full border rounded-md px-2 py-2 bg-background" value={form.booked_tag_id ?? ''}
                                onChange={e => update('booked_tag_id', e.target.value || null)}>
                                <option value="">付けない</option>
                                {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                        </div>
                        <div className="space-y-1">
                            <Label>確定した人に登録するリマインダー</Label>
                            <select className="w-full border rounded-md px-2 py-2 bg-background" value={form.reminder_id ?? ''}
                                onChange={e => update('reminder_id', e.target.value || null)}>
                                <option value="">登録しない</option>
                                {reminders.map(r => <option key={r.id} value={r.id}>{r.name}{r.is_active ? '' : '（停止中）'}</option>)}
                            </select>
                            <p className="text-xs text-slate-500">事前質問・録音のお願い・前日の連絡などは「リマインダー」画面で作ります。</p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <Button onClick={saveSettings} disabled={saving}>
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}保存
                        </Button>
                        {saveMessage && <span className="text-slate-600 dark:text-slate-300">{saveMessage}</span>}
                    </div>
                </CardContent>
            </Card>

            {/* 空き枠 */}
            <Card>
                <CardHeader><CardTitle>面談の空き枠</CardTitle></CardHeader>
                <CardContent className="space-y-4 text-sm">
                    <div className="flex flex-wrap items-end gap-2">
                        <div className="space-y-1">
                            <Label>日付</Label>
                            <Input type="date" value={slotDate} onChange={e => setSlotDate(e.target.value)} />
                        </div>
                        <div className="space-y-1 flex-1 min-w-48">
                            <Label>開始時刻（スペース区切りで複数・日本時間）</Label>
                            <Input value={slotTimes} onChange={e => setSlotTimes(e.target.value)} placeholder="10:00 13:00 16:00" />
                        </div>
                        <Button onClick={addSlots}><Plus className="w-4 h-4" />追加</Button>
                    </div>
                    {slotMessage && <p className="text-slate-600 dark:text-slate-300">{slotMessage}</p>}

                    {slotsByDate.length === 0 ? (
                        <p className="text-slate-500">これからの空き枠はありません。</p>
                    ) : (
                        <div className="space-y-3">
                            {slotsByDate.map(([date, daySlots]) => (
                                <div key={date}>
                                    <p className="font-medium mb-1">{date}</p>
                                    <div className="flex flex-wrap gap-2">
                                        {daySlots.map(slot => (
                                            <div key={slot.id} className={cn('flex items-center gap-2 rounded-md border px-3 py-1.5',
                                                slot.status === 'booked' && 'border-emerald-300 bg-emerald-50 dark:bg-emerald-900/20',
                                                slot.status === 'closed' && 'opacity-60')}>
                                                <span className="font-mono">{formatJstTime(new Date(slot.start_at))}</span>
                                                {slot.status === 'open' && (
                                                    <>
                                                        <span className="text-slate-500">空き</span>
                                                        <button className="text-xs underline" onClick={() => setSlotStatus(slot, 'closed')}>締め切る</button>
                                                        <button onClick={() => deleteSlot(slot)} className="text-slate-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                                                    </>
                                                )}
                                                {slot.status === 'closed' && (
                                                    <>
                                                        <span className="text-slate-500">締切</span>
                                                        <button className="text-xs underline" onClick={() => setSlotStatus(slot, 'open')}>再開</button>
                                                        <button onClick={() => deleteSlot(slot)} className="text-slate-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                                                    </>
                                                )}
                                                {slot.status === 'booked' && (
                                                    <>
                                                        <span className="text-emerald-700">
                                                            予約: {slot.line_users?.internal_name || slot.line_users?.display_name || '（名前なし）'}
                                                        </span>
                                                        <button className="text-xs underline" onClick={() => cancelBooking(slot)}>取り消す</button>
                                                    </>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* やりとり */}
            <Card>
                <CardHeader><CardTitle>日程のやりとり（最近50件）</CardTitle></CardHeader>
                <CardContent>
                    {offers.length === 0 ? (
                        <p className="text-sm text-slate-500">まだやりとりはありません。</p>
                    ) : (
                        <div className="divide-y text-sm">
                            {offers.map(o => (
                                <div key={o.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <span className="font-medium">{o.line_users?.internal_name || o.line_users?.display_name || '（名前なし）'}</span>
                                    <span className={cn('text-xs px-2 py-0.5 rounded-full',
                                        o.status === 'booked' ? 'bg-emerald-100 text-emerald-700'
                                            : needsAction(o) ? 'bg-amber-100 text-amber-800'
                                                : 'bg-slate-100 text-slate-600')}>
                                        {o.status === 'pending' && o.responded_at ? '返信あり（未確定）' : STATUS_LABEL[o.status]}
                                    </span>
                                    {needsAction(o) && <span className="text-xs text-amber-700">要対応：LINE でご本人に返信してください</span>}
                                    {o.booking_slots && <span>{formatJstShort(new Date(o.booking_slots.start_at))}</span>}
                                    <span className="text-slate-500 ml-auto">
                                        候補送信 {formatJstShort(new Date(o.created_at))}
                                        {o.nudged_at && ` ／ 催促 ${formatJstShort(new Date(o.nudged_at))}`}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
