'use client'

import { useEffect, useState } from 'react'
import { FEW_SEATS_THRESHOLD, type FormAvailability } from '@/lib/forms/capacity'
import type { FormEntryStatus, FormField } from '@/types'

interface PublicForm {
    id: string
    title: string | null
    description: string | null
    fields: FormField[]
    availability: FormAvailability | null // 残席設定がオフなら null
}

type AnswerValue = string | string[]

// フォームを開いている間に残席を取り直す間隔
const AVAILABILITY_REFRESH_MS = 30_000

/**
 * 申込フォームの実行本体（LIFF）。
 * formId は /forms（liff.state経由のクエリ）と /forms/[id]（パス）両方から渡される。
 */
export function FormRunner({ formId }: { formId: string | null }) {
    const [form, setForm] = useState<PublicForm | null>(null)
    const [answers, setAnswers] = useState<Record<string, AnswerValue>>({})
    const [accessToken, setAccessToken] = useState<string | null>(null)
    const [status, setStatus] = useState<'loading' | 'ready' | 'submitting' | 'done' | 'error'>('loading')
    const [errorMessage, setErrorMessage] = useState('')
    const [entryStatus, setEntryStatus] = useState<FormEntryStatus>('confirmed')

    // LIFF初期化 → アクセストークン取得 → フォーム定義取得
    useEffect(() => {
        const run = async () => {
            if (!formId) {
                setErrorMessage('フォームが指定されていません')
                setStatus('error')
                return
            }
            try {
                const liffId = process.env.NEXT_PUBLIC_FORM_LIFF_ID
                if (!liffId) {
                    setErrorMessage('フォームの設定が正しくありません（LIFF ID未設定）')
                    setStatus('error')
                    return
                }

                // フォーム定義の取得はLIFFのログイン/トークンに依存しないため、
                // LIFF初期化と並行して先に走らせておく（読み込みの高速化）。
                type FormFetchResult = { ok: boolean; data?: PublicForm; error?: string }
                const formPromise: Promise<FormFetchResult> = fetch(`/api/forms/${formId}`, { cache: 'no-store' })
                    .then(async (res): Promise<FormFetchResult> => {
                        if (!res.ok) {
                            const body = await res.json().catch(() => ({}))
                            return { ok: false, error: body.error || 'フォームを読み込めませんでした' }
                        }
                        return { ok: true, data: (await res.json()) as PublicForm }
                    })
                    .catch((): FormFetchResult => ({ ok: false, error: 'フォームの読み込みに失敗しました' }))

                const liff = (await import('@line/liff')).default
                await liff.init({ liffId })

                if (!liff.isLoggedIn()) {
                    liff.login({ redirectUri: window.location.href })
                    return
                }

                const token = liff.getAccessToken()
                if (!token) {
                    setErrorMessage('ユーザー情報の取得に失敗しました')
                    setStatus('error')
                    return
                }
                setAccessToken(token)

                const result = await formPromise
                if (!result.ok || !result.data) {
                    setErrorMessage(result.error || 'フォームを読み込めませんでした')
                    setStatus('error')
                    return
                }
                setForm(result.data)
                setStatus('ready')
            } catch (err) {
                console.error('フォーム初期化エラー:', err)
                setErrorMessage('フォームの読み込みに失敗しました')
                setStatus('error')
            }
        }

        run()
    }, [formId])

    // 入力している間にも席は埋まっていくので、残席を定期的に取り直す（残席設定がオンのときのみ）
    const hasCapacity = !!form?.availability
    useEffect(() => {
        if (!formId || !hasCapacity) return
        const timer = setInterval(async () => {
            try {
                const res = await fetch(`/api/forms/${formId}`, { cache: 'no-store' })
                if (!res.ok) return
                const latest = (await res.json()) as PublicForm
                setForm((prev) => (prev ? { ...prev, availability: latest.availability } : prev))
            } catch {
                // 取り直しに失敗しても、表示中の残席のまま入力を続けられるようにする
            }
        }, AVAILABILITY_REFRESH_MS)
        return () => clearInterval(timer)
    }, [formId, hasCapacity])

    const setValue = (fieldId: string, value: AnswerValue) => {
        setAnswers((prev) => ({ ...prev, [fieldId]: value }))
    }

    const toggleCheckbox = (fieldId: string, option: string) => {
        setAnswers((prev) => {
            const current = Array.isArray(prev[fieldId]) ? (prev[fieldId] as string[]) : []
            const next = current.includes(option)
                ? current.filter((o) => o !== option)
                : [...current, option]
            return { ...prev, [fieldId]: next }
        })
    }

    const validate = (): string | null => {
        if (!form) return null
        for (const field of form.fields) {
            if (!field.required) continue
            const value = answers[field.id]
            const empty =
                value === undefined ||
                value === null ||
                (typeof value === 'string' && value.trim() === '') ||
                (Array.isArray(value) && value.length === 0)
            if (empty) return `「${field.label}」を入力してください`
        }
        return null
    }

    const handleSubmit = async () => {
        if (!form || !accessToken) return

        const validationError = validate()
        if (validationError) {
            setErrorMessage(validationError)
            return
        }
        setErrorMessage('')
        setStatus('submitting')

        try {
            const res = await fetch(`/api/forms/${form.id}/submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accessToken, answers }),
            })

            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                // 入力中に満席になり締め切られた
                if (data.full && form.availability) {
                    setForm({ ...form, availability: { ...form.availability, remaining: 0, state: 'closed' } })
                    setErrorMessage('')
                    setStatus('ready')
                    return
                }
                setErrorMessage(data.error || '送信に失敗しました')
                setStatus('ready')
                return
            }

            setEntryStatus(data.entryStatus === 'waitlisted' ? 'waitlisted' : 'confirmed')
            setStatus('done')

            // 完了メッセージはトークに届くので、少し待ってからLIFFを閉じる
            setTimeout(async () => {
                try {
                    const liff = (await import('@line/liff')).default
                    if (liff.isInClient()) liff.closeWindow()
                } catch {
                    // 何もしない
                }
            }, 1800)
        } catch (err) {
            console.error('送信エラー:', err)
            setErrorMessage('送信に失敗しました。通信環境をご確認ください。')
            setStatus('ready')
        }
    }

    // ---- 表示 ----
    if (status === 'loading') {
        return (
            <Centered>
                <div className="line-spinner" />
                <p className="mt-6 text-[#06C755] text-lg font-bold">読み込み中...</p>
                <style>{spinnerStyle}</style>
            </Centered>
        )
    }

    if (status === 'error') {
        return (
            <Centered>
                <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center text-2xl">⚠️</div>
                <p className="mt-4 text-slate-700 text-center text-base leading-relaxed">{errorMessage}</p>
            </Centered>
        )
    }

    if (status === 'done') {
        if (entryStatus === 'waitlisted') {
            return (
                <Centered>
                    <div className="w-16 h-16 rounded-full bg-amber-500 flex items-center justify-center text-white text-3xl">✓</div>
                    <p className="mt-5 text-slate-800 text-xl font-bold">キャンセル待ちで受け付けました</p>
                    <p className="mt-2 text-slate-500 text-sm text-center leading-relaxed">
                        定員に達したため、キャンセル待ちでのお申し込みとなりました。<br />
                        お席に空きが出ましたら、トーク画面でご連絡いたします。<br />この画面は自動的に閉じます。
                    </p>
                </Centered>
            )
        }
        return (
            <Centered>
                <div className="w-16 h-16 rounded-full bg-[#06C755] flex items-center justify-center text-white text-3xl">✓</div>
                <p className="mt-5 text-slate-800 text-xl font-bold">送信が完了しました</p>
                <p className="mt-2 text-slate-500 text-sm text-center leading-relaxed">
                    トーク画面に確認メッセージをお送りしました。<br />この画面は自動的に閉じます。
                </p>
            </Centered>
        )
    }

    if (!form) return null

    const availability = form.availability

    // 満席で締め切ったフォーム
    if (availability?.state === 'closed') {
        return (
            <Centered>
                <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center text-2xl">🈵</div>
                <p className="mt-5 text-slate-800 text-lg font-bold text-center">{form.title || 'お申し込みフォーム'}</p>
                <p className="mt-2 text-slate-500 text-sm text-center leading-relaxed">
                    定員に達したため、お申し込みの受付を終了しました。<br />たくさんのお申し込みありがとうございました。
                </p>
            </Centered>
        )
    }

    return (
        <div className="min-h-screen bg-slate-50 text-slate-900">
            <div className="mx-auto max-w-xl px-5 py-8">
                {/* ヘッダー */}
                <div className="mb-6">
                    <div className="w-11 h-11 rounded-xl bg-[#06C755] flex items-center justify-center mb-4">
                        <span className="text-white text-lg font-bold">申</span>
                    </div>
                    <h1 className="text-2xl font-bold leading-snug">{form.title || 'お申し込みフォーム'}</h1>
                    {form.description && (
                        <p className="mt-2 text-sm text-slate-500 whitespace-pre-wrap leading-relaxed">{form.description}</p>
                    )}
                </div>

                {availability && <AvailabilityBanner availability={availability} />}

                {/* 項目 */}
                <div className="space-y-5">
                    {form.fields.map((field) => (
                        <div key={field.id}>
                            <label className="block text-sm font-semibold mb-1.5">
                                {field.label}
                                {field.required && <span className="text-red-500 ml-1">*</span>}
                            </label>
                            {field.description && (
                                <p className="-mt-0.5 mb-2 text-xs text-slate-500 whitespace-pre-wrap leading-relaxed">{field.description}</p>
                            )}
                            <FieldInput
                                field={field}
                                value={answers[field.id]}
                                onChange={(v) => setValue(field.id, v)}
                                onToggleCheckbox={(opt) => toggleCheckbox(field.id, opt)}
                            />
                        </div>
                    ))}
                </div>

                {errorMessage && (
                    <p className="mt-5 text-sm text-red-500 text-center">{errorMessage}</p>
                )}

                <button
                    onClick={handleSubmit}
                    disabled={status === 'submitting'}
                    className="mt-8 w-full py-3.5 rounded-xl bg-[#06C755] text-white font-bold text-base shadow-sm active:scale-[0.99] transition disabled:opacity-60"
                >
                    {status === 'submitting'
                        ? '送信中...'
                        : availability?.state === 'waitlist' ? 'キャンセル待ちで申し込む' : '送信する'}
                </button>

                <p className="mt-4 text-center text-xs text-slate-400">
                    ※ このフォームはLINEアカウントと連携しています
                </p>
            </div>
        </div>
    )
}

/**
 * 残席のカウントダウン表示。満席でキャンセル待ちを受け付けている間はその旨を出す。
 */
function AvailabilityBanner({ availability }: { availability: FormAvailability }) {
    const { capacity, remaining, state } = availability

    if (state === 'waitlist') {
        return (
            <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-sm font-bold text-amber-800">満席です（定員 {capacity} 席）</p>
                <p className="mt-1 text-xs text-amber-700 leading-relaxed">
                    ただいまキャンセル待ちとしてお申し込みを受け付けています。お席に空きが出ましたら、順番にご連絡いたします。
                </p>
            </div>
        )
    }

    const few = remaining <= FEW_SEATS_THRESHOLD
    const filledPercent = Math.min(100, Math.round(((capacity - remaining) / capacity) * 100))
    return (
        <div className={`mb-6 rounded-xl border px-4 py-3 ${few ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'}`}>
            <div className="flex items-baseline justify-between gap-3">
                <p className={`text-sm font-bold ${few ? 'text-red-600' : 'text-emerald-700'}`}>
                    {few ? '残りわずか！' : '受付中'}
                </p>
                <p className="text-slate-700">
                    <span className="text-xs">残り</span>
                    <span className={`mx-1 text-2xl font-bold tabular-nums ${few ? 'text-red-600' : 'text-emerald-700'}`}>{remaining}</span>
                    <span className="text-xs">席 / 定員 {capacity} 席</span>
                </p>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-white/80 overflow-hidden">
                <div
                    className={`h-full rounded-full ${few ? 'bg-red-500' : 'bg-[#06C755]'}`}
                    style={{ width: `${filledPercent}%` }}
                />
            </div>
        </div>
    )
}

function FieldInput({
    field,
    value,
    onChange,
    onToggleCheckbox,
}: {
    field: FormField
    value: AnswerValue | undefined
    onChange: (v: string) => void
    onToggleCheckbox: (option: string) => void
}) {
    const baseInput =
        'w-full px-3.5 py-2.5 rounded-lg border border-slate-300 bg-white text-base focus:outline-none focus:ring-2 focus:ring-[#06C755] focus:border-transparent'

    switch (field.type) {
        case 'textarea':
            return (
                <textarea
                    className={`${baseInput} min-h-[120px] resize-y`}
                    placeholder={field.placeholder}
                    value={(value as string) || ''}
                    onChange={(e) => onChange(e.target.value)}
                />
            )
        case 'select':
            return (
                <select
                    className={baseInput}
                    value={(value as string) || ''}
                    onChange={(e) => onChange(e.target.value)}
                >
                    <option value="">選択してください</option>
                    {(field.options || []).map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                    ))}
                </select>
            )
        case 'radio':
            return (
                <div className="space-y-2">
                    {(field.options || []).map((opt) => (
                        <label key={opt} className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border border-slate-300 bg-white cursor-pointer">
                            <input
                                type="radio"
                                name={field.id}
                                checked={value === opt}
                                onChange={() => onChange(opt)}
                                className="w-4 h-4 accent-[#06C755]"
                            />
                            <span className="text-base">{opt}</span>
                        </label>
                    ))}
                </div>
            )
        case 'checkbox':
            return (
                <div className="space-y-2">
                    {(field.options || []).map((opt) => {
                        const checked = Array.isArray(value) && value.includes(opt)
                        return (
                            <label key={opt} className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border border-slate-300 bg-white cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => onToggleCheckbox(opt)}
                                    className="w-4 h-4 accent-[#06C755]"
                                />
                                <span className="text-base">{opt}</span>
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
                <input
                    type={inputType}
                    className={baseInput}
                    placeholder={field.placeholder}
                    value={(value as string) || ''}
                    onChange={(e) => onChange(e.target.value)}
                />
            )
        }
    }
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
            {children}
        </div>
    )
}

const spinnerStyle = `
@keyframes spin { to { transform: rotate(360deg); } }
.line-spinner {
    width: 48px; height: 48px;
    border: 5px solid #d4f5e2;
    border-top-color: #06C755;
    border-radius: 50%;
    animation: spin 0.85s linear infinite;
}
`
