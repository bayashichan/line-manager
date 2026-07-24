import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

/**
 * 公開フォーム定義の取得（LIFFフォームページから呼ばれる・未認証）
 * GET /api/forms/[id]
 *
 * 申込者に見せて問題のない項目のみを返す（channel_access_token 等は返さない）。
 */
export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params

    try {
        const supabase = createAdminClient()
        const { data: form, error } = await supabase
            .from('forms')
            .select('id, title, description, fields, is_active')
            .eq('id', id)
            .single()

        if (error || !form) {
            return NextResponse.json({ error: 'フォームが見つかりません' }, { status: 404 })
        }

        if (!form.is_active) {
            return NextResponse.json({ error: 'このフォームは現在受付を停止しています' }, { status: 403 })
        }

        return NextResponse.json({
            id: form.id,
            title: form.title,
            description: form.description,
            fields: form.fields ?? [],
        })
    } catch (error) {
        console.error('フォーム取得エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
