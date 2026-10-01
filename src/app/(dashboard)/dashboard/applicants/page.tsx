'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { Button, Input, Card, CardContent } from '@/components/ui'
import { cn, formatDateTime, getCookie } from '@/lib/utils'
import type { Applicant, Form, FormField, FormResponse, LineUser } from '@/types'
import {
    CompletionReplyBadge,
    completionReplyDetail,
    completionReplyLabel,
    isCompletionReplyUndelivered,
} from '@/components/completion-reply-status'
import {
    Search,
    Loader2,
    AlertCircle,
    UserX,
    UserCheck,
    User,
    MessageCircle,
    Download,
    Copy,
    Check,
    ClipboardList,
    ExternalLink,
    ChevronDown,
    ChevronUp,
    Plus,
} from 'lucide-react'

/**
 * 申込者一覧。
 *
 * 主役はこのアプリの申込フォーム（form_responses）から申し込んだ人。フォームごとに
 * 申込者を並べ、回答内容と友だち状態を1画面で確認できるようにする。
 *
 * 外部の申込フォームから連携された申込者（applicants）は、連携データがあるときだけ
 * 別タブで表示する。連携を使っていないアカウントで空のタブを見せて混乱させないため。
 */
export default function ApplicantsPage() {
    const [loading, setLoading] = useState(true)
    const [channelId, setChannelId] = useState<string | null>(null)
    const [externalCount, setExternalCount] = useState(0)
    const [view, setView] = useState<'forms' | 'external'>('forms')

    // 初回のみ実行する（他のダッシュボード画面と同じ方針）
    useEffect(() => {
        const fetchChannel = async () => {
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
                const id = memberships[0].channel_id
                setChannelId(id)

                const { count } = await supabase
                    .from('applicants')
                    .select('id', { count: 'exact', head: true })
                    .eq('channel_id', id)
                setExternalCount(count ?? 0)
            }

            setLoading(false)
        }

        fetchChannel()
    }, [])

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
            <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                    申込者
                </h1>
                <p className="text-slate-500 dark:text-slate-400 mt-1">
                    申込フォームから申し込んだ人の一覧です
                </p>
            </div>

            {externalCount > 0 && (
                <div className="flex gap-2 flex-wrap">
                    <Button
                        variant={view === 'forms' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setView('forms')}
                    >
                        <ClipboardList className="w-4 h-4 mr-1" />
                        申込フォーム
                    </Button>
                    <Button
                        variant={view === 'external' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setView('external')}
                    >
                        <ExternalLink className="w-4 h-4 mr-1" />
                        外部フォーム連携（{externalCount}）
                    </Button>
                </div>
            )}

            {!channelId ? (
                <div className="text-center py-12 text-slate-500">
                    LINE公式アカウントが選択されていません
                </div>
            ) : view === 'forms' ? (
                <FormApplicantsView channelId={channelId} />
            ) : (
                <ExternalApplicantsView channelId={channelId} />
            )}
        </div>
    )
}

// =============================================================================
// 申込フォームの申込者
// =============================================================================

type ApplicantUser = Pick<
    LineUser,
    'id' | 'line_user_id' | 'display_name' | 'internal_name' | 'picture_url' | 'is_blocked'
>

type FriendStatus = 'friend' | 'blocked' | 'not_friend'

const FRIEND_STATUS_LABELS: Record<FriendStatus, string> = {
    friend: '友だち',
    blocked: 'ブロック中',
    not_friend: '未友だち',
}

const FRIEND_STATUS_CLASSES: Record<FriendStatus, string> = {
    friend: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    blocked: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
    not_friend: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
}

// 一覧で最初から見せる回答の数。これを超える分は行ごとに開いて見る
const SUMMARY_FIELD_COUNT = 4

// line_users を userId の IN 句で引くときの分割数（URL長の上限に当てないため）
const USER_LOOKUP_CHUNK = 100

function friendStatusOf(user: ApplicantUser | undefined): FriendStatus {
    if (!user) return 'not_friend'
    return user.is_blocked ? 'blocked' : 'friend'
}

function answerText(response: FormResponse, fieldId: string): string {
    const val = response.answers[fieldId]
    if (val === undefined || val === null) return ''
    return Array.isArray(val) ? val.join('、') : String(val)
}

/**
 * 申込者が自分で入力した名前の項目を質問ラベルから推定する（例: お名前、氏名）。
 * 申込者を見分けるにはLINE表示名よりこちらが確実なので、一覧の見出しに使う。
 */
function findNameField(fields: FormField[]): FormField | undefined {
    return fields.find(f => f.type === 'text' && /名前|氏名/.test(f.label))
}

function FormApplicantsView({ channelId }: { channelId: string }) {
    const router = useRouter()
    const [forms, setForms] = useState<Form[]>([])
    const [responseCounts, setResponseCounts] = useState<Record<string, number>>({})
    const [selectedFormId, setSelectedFormId] = useState<string | null>(null)
    const [responses, setResponses] = useState<FormResponse[]>([])
    const [users, setUsers] = useState<Record<string, ApplicantUser>>({})
    const [loading, setLoading] = useState(true)
    const [listLoading, setListLoading] = useState(false)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
    // フォームを素早く切り替えたとき、前のフォームの取得結果で一覧を上書きしないための通し番号
    const requestSeq = useRef(0)

    const fetchForms = async () => {
        const supabase = createClient()

        const { data, error } = await supabase
            .from('forms')
            .select('*')
            .eq('channel_id', channelId)
            .order('created_at', { ascending: false })

        if (error) {
            console.error('申込フォームの取得エラー:', error)
            setLoadError('申込フォームの取得に失敗しました。時間をおいて再読み込みしてください。')
            setLoading(false)
            return
        }

        const formList = (data ?? []) as Form[]
        const counts: Record<string, number> = {}
        await Promise.all(
            formList.map(async (f) => {
                const { count } = await supabase
                    .from('form_responses')
                    .select('id', { count: 'exact', head: true })
                    .eq('form_id', f.id)
                counts[f.id] = count ?? 0
            })
        )

        setForms(formList)
        setResponseCounts(counts)
        setLoading(false)

        // 申込が入っているフォームを優先して開く（新しく作ったフォームほど先頭にある）
        const initial = formList.find(f => counts[f.id] > 0) ?? formList[0]
        if (initial) handleSelectForm(initial.id)
    }

    const fetchResponses = async (formId: string) => {
        const seq = ++requestSeq.current
        const supabase = createClient()

        setListLoading(true)
        setLoadError(null)

        // 1000行上限に当たらないようページングして全件取得する
        const { data, error } = await fetchAllRows<FormResponse>((from, to) =>
            supabase
                .from('form_responses')
                .select('*')
                .eq('form_id', formId)
                .order('created_at', { ascending: false })
                .order('id', { ascending: true })
                .range(from, to)
        )

        // 申込の後に友だち追加した人も友だちとして扱えるよう、保存時の内部IDではなく
        // LINEのuserIdで line_users を引き直す
        const rawIds = [...new Set(data.map(r => r.line_user_id_raw).filter((id): id is string => !!id))]
        const userMap: Record<string, ApplicantUser> = {}
        let userError: unknown = null
        for (let i = 0; i < rawIds.length; i += USER_LOOKUP_CHUNK) {
            const { data: userRows, error: chunkError } = await supabase
                .from('line_users')
                .select('id, line_user_id, display_name, internal_name, picture_url, is_blocked')
                .eq('channel_id', channelId)
                .in('line_user_id', rawIds.slice(i, i + USER_LOOKUP_CHUNK))
            if (chunkError) {
                userError = chunkError
                break
            }
            for (const u of (userRows ?? []) as ApplicantUser[]) {
                userMap[u.line_user_id] = u
            }
        }

        if (seq !== requestSeq.current) return

        if (error || userError) {
            console.error('申込者一覧の取得エラー:', error || userError)
            setLoadError('申込者一覧の取得に失敗しました。時間をおいて再読み込みしてください。')
        }

        setResponses(data)
        setUsers(userMap)
        if (!error) {
            setResponseCounts(prev => ({ ...prev, [formId]: data.length }))
        }
        setListLoading(false)
    }

    const handleSelectForm = (formId: string) => {
        setSelectedFormId(formId)
        setExpandedIds(new Set())
        fetchResponses(formId)
    }

    // 初回のみ実行する（他のダッシュボード画面と同じ方針）
    useEffect(() => {
        fetchForms()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const toggleExpanded = (responseId: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev)
            if (next.has(responseId)) {
                next.delete(responseId)
            } else {
                next.add(responseId)
            }
            return next
        })
    }

    const userOf = (response: FormResponse) =>
        response.line_user_id_raw ? users[response.line_user_id_raw] : undefined

    const form = forms.find(f => f.id === selectedFormId)
    const nameField = form ? findNameField(form.fields) : undefined
    const detailFields = form ? form.fields.filter(f => f.id !== nameField?.id) : []

    const q = searchQuery.trim().toLowerCase()
    const filtered = q
        ? responses.filter(r => {
            const user = userOf(r)
            const values = [
                user?.display_name,
                user?.internal_name,
                ...Object.values(r.answers).flat(),
            ]
            return values.some(v => v != null && String(v).toLowerCase().includes(q))
        })
        : responses

    const notFriendCount = responses.filter(r => friendStatusOf(userOf(r)) !== 'friend').length
    const waitlistCount = responses.filter(r => r.entry_status === 'waitlisted').length
    const undeliveredCount = responses.filter(isCompletionReplyUndelivered).length

    const handleExportCSV = () => {
        if (!form) return

        const escape = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
        const headers = ['申込日時', '本人による修正日時', '申込状態', 'LINE表示名', '管理用ネーム', '友だち状態', 'LINE userId', '自動返信', '自動返信の理由', ...form.fields.map(f => f.label)]
        const rows = filtered.map(r => {
            const user = userOf(r)
            return [
                formatDateTime(r.created_at),
                r.edited_at ? formatDateTime(r.edited_at) : '',
                r.entry_status === 'waitlisted' ? 'キャンセル待ち' : '申込',
                user?.display_name || '',
                user?.internal_name || '',
                FRIEND_STATUS_LABELS[friendStatusOf(user)],
                r.line_user_id_raw || '',
                completionReplyLabel(r),
                completionReplyDetail(r) || '',
                ...form.fields.map(f => answerText(r, f.id)),
            ]
        })

        const csv = [headers, ...rows].map(row => row.map(escape).join(',')).join('\r\n')
        // Excelでの文字化け防止のためUTF-8 BOMを付与
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${form.name}_申込者_${new Date().toISOString().slice(0, 10)}.csv`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center h-32">
                <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
            </div>
        )
    }

    if (forms.length === 0) {
        return (
            <div className="text-center py-12">
                {loadError ? (
                    <div className="flex items-center justify-center gap-2 text-red-600 dark:text-red-400 text-sm">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        {loadError}
                    </div>
                ) : (
                    <>
                        <div className="w-16 h-16 mx-auto mb-4 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center">
                            <ClipboardList className="w-8 h-8 text-slate-400" />
                        </div>
                        <p className="text-slate-500">このアカウントには申込フォームがまだありません</p>
                        <p className="text-sm text-slate-400 mt-1 mb-4">
                            申込フォームを作成すると、申し込んだ人がここに一覧で表示されます
                        </p>
                        <Button asChild>
                            <Link href="/dashboard/forms">
                                <Plus className="w-4 h-4" />
                                申込フォームを作成
                            </Link>
                        </Button>
                    </>
                )}
            </div>
        )
    }

    return (
        <div className="space-y-4">
            {/* フォーム選択 */}
            <div className="space-y-2">
                <p className="text-sm font-medium text-slate-600 dark:text-slate-300">フォームを選ぶ</p>
                <div className="flex gap-2 flex-wrap">
                    {forms.map(f => (
                        <Button
                            key={f.id}
                            variant={f.id === selectedFormId ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => f.id !== selectedFormId && handleSelectForm(f.id)}
                        >
                            {f.name}（{responseCounts[f.id] ?? 0}）
                            {!f.is_active && <span className="text-xs opacity-75">停止中</span>}
                        </Button>
                    ))}
                </div>
            </div>

            {/* 件数とCSV */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-slate-500 dark:text-slate-400">
                    {q ? `${filtered.length} / ${responses.length}` : responses.length} 件の申込
                    {notFriendCount > 0 && `（うち友だち以外 ${notFriendCount} 件）`}
                    {waitlistCount > 0 && `（うちキャンセル待ち ${waitlistCount} 件）`}
                    {listLoading && (
                        <Loader2 className="inline w-3 h-3 ml-2 animate-spin text-slate-400" />
                    )}
                </p>
                <Button variant="outline" onClick={handleExportCSV} disabled={filtered.length === 0}>
                    <Download className="w-4 h-4" />
                    CSVエクスポート
                </Button>
            </div>

            {notFriendCount > 0 && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-md bg-amber-50 text-amber-800 text-sm dark:bg-amber-900/20 dark:text-amber-300">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                        「未友だち」「ブロック中」の人にはLINEでメッセージを送れません。
                        必要に応じて回答のメールアドレスや電話番号でご連絡ください。
                    </span>
                </div>
            )}

            {undeliveredCount > 0 && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-md bg-red-50 text-red-700 text-sm dark:bg-red-900/20 dark:text-red-300">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                        自動返信が届いていない可能性がある申込が {undeliveredCount} 件あります。
                        「自動返信: 失敗」「自動返信: 結果不明」の申込は、理由を確認のうえ個別にご連絡ください。
                    </span>
                </div>
            )}

            {loadError && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-md bg-red-50 text-red-700 text-sm dark:bg-red-900/20 dark:text-red-300">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {loadError}
                </div>
            )}

            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                    placeholder="名前・回答内容で検索..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                />
            </div>

            {/* 一覧 */}
            {filtered.length > 0 && (
                <Card>
                    <div className="divide-y divide-slate-100 dark:divide-slate-800">
                        {filtered.map(r => {
                            const user = userOf(r)
                            const status = friendStatusOf(user)
                            const enteredName = nameField ? answerText(r, nameField.id) : ''
                            const lineName = user?.internal_name || user?.display_name || ''
                            const expanded = expandedIds.has(r.id)
                            const shownFields = expanded ? detailFields : detailFields.slice(0, SUMMARY_FIELD_COUNT)
                            const hiddenCount = detailFields.length - SUMMARY_FIELD_COUNT
                            const replyDetail = completionReplyDetail(r)

                            return (
                                <div key={r.id} className="p-4 flex items-start gap-3">
                                    {user?.picture_url ? (
                                        <img
                                            src={user.picture_url}
                                            alt={user.display_name || ''}
                                            className="w-10 h-10 rounded-full object-cover shrink-0"
                                        />
                                    ) : (
                                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center shrink-0">
                                            <User className="w-5 h-5 text-slate-500" />
                                        </div>
                                    )}

                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                    <h3 className="font-medium truncate">
                                                        {enteredName || lineName || '名前なし'}
                                                    </h3>
                                                    <span className={cn('px-2 py-0.5 text-xs rounded-full', FRIEND_STATUS_CLASSES[status])}>
                                                        {FRIEND_STATUS_LABELS[status]}
                                                    </span>
                                                    {r.entry_status === 'waitlisted' && (
                                                        <span className="px-2 py-0.5 text-xs rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                                                            キャンセル待ち
                                                        </span>
                                                    )}
                                                    <CompletionReplyBadge record={r} />
                                                </div>
                                                <p className="text-xs text-slate-400 mt-0.5">
                                                    {formatDateTime(r.created_at)} 申込
                                                    {r.edited_at && (
                                                        <span className="text-sky-600 dark:text-sky-400"> ・ {formatDateTime(r.edited_at)} 本人が修正</span>
                                                    )}
                                                    {enteredName && lineName && enteredName !== lineName && (
                                                        <span className="text-slate-500"> ・ LINE: {lineName}</span>
                                                    )}
                                                </p>
                                                {replyDetail && (
                                                    <p className={cn(
                                                        'text-xs mt-0.5 break-words',
                                                        isCompletionReplyUndelivered(r) ? 'text-red-600 dark:text-red-400' : 'text-slate-500'
                                                    )}>
                                                        自動返信: {replyDetail}
                                                    </p>
                                                )}
                                            </div>
                                            {status === 'friend' && user && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    title="1:1チャットを開く"
                                                    className="shrink-0 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                                                    onClick={() => router.push(`/dashboard/chats?userId=${user.id}`)}
                                                >
                                                    <MessageCircle className="w-5 h-5" />
                                                </Button>
                                            )}
                                        </div>

                                        {shownFields.length > 0 && (
                                            <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                                                {shownFields.map(f => {
                                                    const value = answerText(r, f.id)
                                                    return (
                                                        <div key={f.id} className="min-w-0">
                                                            <dt className="text-xs text-slate-400 truncate" title={f.label}>
                                                                {f.label}
                                                            </dt>
                                                            <dd className="text-sm text-slate-700 dark:text-slate-200 break-words whitespace-pre-wrap">
                                                                {value || <span className="text-slate-300 dark:text-slate-600">未回答</span>}
                                                            </dd>
                                                        </div>
                                                    )
                                                })}
                                            </dl>
                                        )}

                                        {hiddenCount > 0 && (
                                            <button
                                                onClick={() => toggleExpanded(r.id)}
                                                aria-expanded={expanded}
                                                className="mt-2 flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
                                            >
                                                {expanded ? (
                                                    <>
                                                        <ChevronUp className="w-3.5 h-3.5" />
                                                        閉じる
                                                    </>
                                                ) : (
                                                    <>
                                                        <ChevronDown className="w-3.5 h-3.5" />
                                                        残り{hiddenCount}項目の回答を見る
                                                    </>
                                                )}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </Card>
            )}

            {filtered.length === 0 && !listLoading && (
                <div className="text-center py-12 text-slate-500">
                    {q ? '検索条件に一致する申込者がいません' : 'このフォームへの申込はまだありません'}
                </div>
            )}
        </div>
    )
}

// =============================================================================
// 外部フォーム連携の申込者
// =============================================================================

/**
 * 外部の申込フォームから連携された申込者を、公式アカウントの友だちかどうかで
 * 振り分けて表示する。LIFFのログインは「認証」であって友だち追加ではないため、
 * 申込は済んでいるが友だちではない人が発生する。その人たちを取りこぼさず
 * 追跡できるようにするのがこのタブの目的。
 */
function ExternalApplicantsView({ channelId }: { channelId: string }) {
    const router = useRouter()
    const [applicants, setApplicants] = useState<Applicant[]>([])
    const [listLoading, setListLoading] = useState(false)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [showFriends, setShowFriends] = useState(false)
    const [notFriendCount, setNotFriendCount] = useState(0)
    const [friendCount, setFriendCount] = useState(0)
    const [copiedId, setCopiedId] = useState<string | null>(null)

    const fetchData = async (friendView: boolean = showFriends) => {
        const supabase = createClient()

        setListLoading(true)
        setLoadError(null)

        // 1000行上限に当たらないようページングして全件取得する
        const { data, error } = await fetchAllRows<Applicant>((from, to) =>
            supabase
                .from('applicants')
                .select('*')
                .eq('channel_id', channelId)
                .eq('is_friend', friendView)
                .order('created_at', { ascending: false })
                .order('id', { ascending: true })
                .range(from, to)
        )

        if (error) {
            console.error('申込者一覧の取得エラー:', error)
            setLoadError('申込者一覧の取得に失敗しました。時間をおいて再読み込みしてください。')
        }

        setApplicants(data)
        setListLoading(false)

        const [notFriendResult, friendResult] = await Promise.all([
            supabase
                .from('applicants')
                .select('id', { count: 'exact', head: true })
                .eq('channel_id', channelId)
                .eq('is_friend', false),
            supabase
                .from('applicants')
                .select('id', { count: 'exact', head: true })
                .eq('channel_id', channelId)
                .eq('is_friend', true),
        ])

        setNotFriendCount(notFriendResult.count ?? 0)
        setFriendCount(friendResult.count ?? 0)
    }

    // 初回のみ実行する（他のダッシュボード画面と同じ方針）
    useEffect(() => {
        fetchData()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const handleViewChange = (friendView: boolean) => {
        if (friendView === showFriends) return
        setShowFriends(friendView)
        fetchData(friendView)
    }

    const filtered = applicants.filter(a => {
        const q = searchQuery.toLowerCase()
        return (
            (a.display_name?.toLowerCase() || '').includes(q) ||
            (a.internal_name?.toLowerCase() || '').includes(q) ||
            (a.tag_names || []).some(name => name.toLowerCase().includes(q)) ||
            a.line_user_id.toLowerCase().includes(q) ||
            a.source.toLowerCase().includes(q)
        )
    })

    const copyUserId = async (applicant: Applicant) => {
        try {
            await navigator.clipboard.writeText(applicant.line_user_id)
            setCopiedId(applicant.id)
            setTimeout(() => setCopiedId(null), 1500)
        } catch {
            // クリップボードが使えない環境では何もしない
        }
    }

    const handleExportCSV = () => {
        const headers = ['LINE表示名', '管理用ネーム', 'タグ', 'LINE userId', '申込元', '友だち', '申込日時', '連携日時']
        const rows = filtered.map(a => [
            a.display_name || '',
            a.internal_name || '',
            (a.tag_names || []).join(', '),
            a.line_user_id,
            a.source,
            a.is_friend ? '友だち' : '未友だち',
            a.applied_at ? new Date(a.applied_at).toLocaleString('ja-JP') : '',
            new Date(a.created_at).toLocaleString('ja-JP'),
        ])

        const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `applicants${showFriends ? '' : '_not_friend'}_${new Date().toISOString().split('T')[0]}.csv`
        a.click()
    }

    return (
        <div className="space-y-6">
            {/* 件数とCSV */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-slate-500 dark:text-slate-400">
                    外部の申込フォームから連携された申込者 {filtered.length} / {applicants.length} 人
                    {showFriends ? '（友だち）' : '（未友だち）'}
                    {listLoading && (
                        <Loader2 className="inline w-3 h-3 ml-2 animate-spin text-slate-400" />
                    )}
                </p>
                <Button variant="outline" onClick={handleExportCSV} disabled={filtered.length === 0}>
                    <Download className="w-4 h-4" />
                    CSVエクスポート
                </Button>
            </div>

            {!showFriends && notFriendCount > 0 && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-md bg-amber-50 text-amber-800 text-sm dark:bg-amber-900/20 dark:text-amber-300">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                        この人たちは申込を完了していますが、公式アカウントの友だちではありません。
                        メッセージを送ることができないため、個別に友だち追加をご案内してください。
                    </span>
                </div>
            )}

            {loadError && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-md bg-red-50 text-red-700 text-sm dark:bg-red-900/20 dark:text-red-300">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {loadError}
                </div>
            )}

            {/* 表示切替と検索 */}
            <div className="flex flex-col gap-3">
                <div className="flex gap-2 flex-wrap">
                    <Button
                        variant={showFriends ? 'outline' : 'default'}
                        size="sm"
                        onClick={() => handleViewChange(false)}
                    >
                        <UserX className="w-4 h-4 mr-1" />
                        未友だち（{notFriendCount}）
                    </Button>
                    <Button
                        variant={showFriends ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleViewChange(true)}
                    >
                        <UserCheck className="w-4 h-4 mr-1" />
                        友だち（{friendCount}）
                    </Button>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                        placeholder="表示名・管理用ネーム・タグ・userId・申込元で検索..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                    />
                </div>
            </div>

            {/* 一覧 */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filtered.map(applicant => (
                    <Card key={applicant.id}>
                        <CardContent className="p-4">
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <h3 className="font-medium truncate">
                                        {applicant.internal_name || applicant.display_name || '名前なし'}
                                    </h3>
                                    {applicant.internal_name && applicant.display_name && applicant.internal_name !== applicant.display_name && (
                                        <p className="text-sm text-slate-500 truncate">
                                            LINE名: {applicant.display_name}
                                        </p>
                                    )}
                                </div>
                                {applicant.is_friend && applicant.linked_line_user_id && (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="shrink-0 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                                        onClick={() =>
                                            router.push(`/dashboard/chats?userId=${applicant.linked_line_user_id}`)
                                        }
                                    >
                                        <MessageCircle className="w-5 h-5" />
                                    </Button>
                                )}
                            </div>

                            <button
                                onClick={() => copyUserId(applicant)}
                                title="userIdをコピー"
                                className="mt-2 flex items-center gap-1 text-xs font-mono text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                            >
                                {copiedId === applicant.id ? (
                                    <Check className="w-3 h-3 text-emerald-500" />
                                ) : (
                                    <Copy className="w-3 h-3" />
                                )}
                                <span className="truncate">{applicant.line_user_id}</span>
                            </button>

                            <div className="flex flex-wrap gap-1 mt-3">
                                <span className="px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                    {applicant.source}
                                </span>
                                <span
                                    className={
                                        applicant.is_friend
                                            ? 'px-2 py-0.5 text-xs rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                                            : 'px-2 py-0.5 text-xs rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                    }
                                >
                                    {applicant.is_friend ? '友だち' : '未友だち'}
                                </span>
                                {(applicant.tag_names || []).map(name => (
                                    <span
                                        key={name}
                                        title={applicant.profile_applied_at ? 'タグ付け済み' : '友だち追加後にタグ付けされます'}
                                        className="px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                                    >
                                        {name}
                                    </span>
                                ))}
                            </div>

                            <p className="text-xs text-slate-400 mt-3">
                                申込: {applicant.applied_at ? formatDateTime(applicant.applied_at) : '不明'}
                            </p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {filtered.length === 0 && !listLoading && (
                <div className="text-center py-12 text-slate-500">
                    {searchQuery
                        ? '検索条件に一致する申込者がいません'
                        : showFriends
                            ? '友だちの申込者はまだいません'
                            : '未友だちの申込者はいません'}
                </div>
            )}
        </div>
    )
}
