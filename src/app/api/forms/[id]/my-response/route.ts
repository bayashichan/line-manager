import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { findLatestOwnResponse, verifyLineAccessToken } from '@/lib/forms/respondent'
import { toMyFormResponse } from '@/lib/forms/resubmit'
import type { Form } from '@/types'

/**
 * 申込者本人の申込の取得（LIFFフォームページから呼ばれる）
 * GET /api/forms/[id]/my-response
 *
 * ヘッダー:
 * - Authorization: Bearer {LIFFのアクセストークン}（本人特定のためサーバー側で検証）
 *
 * 1人1回までのフォームで本人が申込済みなら、その申込内容を返す（LIFF側で
 * 「申込済みです。内容を修正しますか？」と聞くため）。それ以外は response: null。
 * 本人の申込しか返さない。
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params

    try {
        const accessToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
        if (!accessToken) {
            return NextResponse.json({ error: 'アクセストークンがありません' }, { status: 401 })
        }

        const supabase = createAdminClient()
        // 列を指定しない: 1人1回までの設定の列はマイグレーション適用前には無く、指定すると取得ごと失敗する
        const { data, error } = await supabase
            .from('forms')
            .select('*')
            .eq('id', id)
            .single()

        if (error || !data) {
            return NextResponse.json({ error: 'フォームが見つかりません' }, { status: 404 })
        }
        const form = data as Form

        // 何度でも申し込めるフォームでは、申込済みかどうかを聞く必要がない（LINEへの問い合わせも省く）
        if (form.one_response_per_user !== true) {
            return NextResponse.json({ response: null })
        }

        const verified = await verifyLineAccessToken(accessToken)
        if (!verified) {
            return NextResponse.json({ error: 'ユーザー認証に失敗しました' }, { status: 401 })
        }

        const existing = await findLatestOwnResponse(supabase, form.id, verified.userId)
        return NextResponse.json({ response: existing ? toMyFormResponse(existing) : null })
    } catch (error) {
        console.error('申込済みの回答の取得エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
