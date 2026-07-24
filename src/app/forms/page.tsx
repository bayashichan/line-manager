'use client'

import { useState } from 'react'
import { FormRunner } from '@/components/form-runner'

/**
 * 申込フォームのLIFFエンドポイント（/forms）。
 *
 * LINEはLIFF URL `https://liff.line.me/{liffId}?form={formId}` を開くとき、
 * クエリを `?liff.state=` に包んでこのエンドポイントへ渡す（既存の /liff と同じ挙動）。
 * そのため form パラメータは通常のクエリと liff.state の両方から取り出す。
 */
export default function FormsIndexPage() {
    const [formId] = useState<string | null>(() => resolveFormId())
    return <FormRunner formId={formId} />
}

function resolveFormId(): string | null {
    if (typeof window === 'undefined') return null

    const urlParams = new URLSearchParams(window.location.search)
    const liffState = urlParams.get('liff.state')
    const params = liffState
        ? new URLSearchParams(decodeURIComponent(liffState).replace(/^\?/, ''))
        : urlParams

    // クエリ ?form=xxx を最優先。無ければ liff.state にパス形式(/xxx)で
    // 入っているケースにもフォールバックする。
    const id = params.get('form')
    if (id) return id

    if (liffState) {
        const decoded = decodeURIComponent(liffState)
        const match = decoded.match(/([0-9a-fA-F-]{36})/)
        if (match) return match[1]
    }
    return null
}
