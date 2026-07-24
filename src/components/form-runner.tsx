'use client'

import { useEffect, useState } from 'react'
import type { FormField } from '@/types'

interface PublicForm {
    id: string
    title: string | null
    description: string | null
    fields: FormField[]
}

type AnswerValue = string | string[]

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

    // LIFF初期化 → アクセストークン取得 → フォーム定義取得
    useEffect(() => {
        const run = async () => {
            if (!formId) {
                setErrorMessage('フォームが指定されていません')
                setStatus('error')
                return
            }
            try {
                const liff = (await import('@line/liff')).default
                const liffId = process.env.NEXT_PUBLIC_FORM_LIFF_ID
                if (!liffId) {
                    setErrorMessage('フォームの設定が正しくありません（LIFF ID未設定）')
                    setStatus('error')
                    return
                }

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

                const res = await fetch(`/api/forms/${formId}`)
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}))
                    setErrorMessage(data.error || 'フォームを読み込めませんでした')
                    setStatus('error')
                    return
                }
                const data: PublicForm = await res.json()
                setForm(data)
                setStatus('ready')
            } catch (err) {
                console.error('フォーム初期化エラー:', err)
                setErrorMessage('フォームの読み込みに失敗しました')
                setStatus('error')
            }
        }

        run()
    }, [formId])

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

            if (!res.ok) {
                const data = await res.json().catch(() => ({}))
                setErrorMessage(data.error || '送信に失敗しました')
                setStatus('ready')
                return
            }

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

                {/* 項目 */}
                <div className="space-y-5">
                    {form.fields.map((field) => (
                        <div key={field.id}>
                            <label className="block text-sm font-semibold mb-1.5">
                                {field.label}
                                {field.required && <span className="text-red-500 ml-1">*</span>}
                            </label>
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
                    {status === 'submitting' ? '送信中...' : '送信する'}
                </button>

                <p className="mt-4 text-center text-xs text-slate-400">
                    ※ このフォームはLINEアカウントと連携しています
                </p>
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
