import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { computeAvailability } from '@/lib/forms/capacity'
import type { Form } from '@/types'

/**
 * 公開フォーム定義の取得（LIFFフォームページから呼ばれる・未認証）
 * GET /api/forms/[id]
 *
 * 申込者に見せて問題のない項目のみを返す（channel_access_token 等は返さない）。
 * 残席設定がオンなら残席数と受付状況（availability）も返す。フォームを開いている
 * 間も残席が減っていくので、LIFF側は定期的にこのAPIを呼び直す。
 * 1人1回までのフォーム（onePerUser）なら、LIFF側は本人が申込済みかを確かめてから開く。
 */
export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params

    try {
        const supabase = createAdminClient()
        // 列を指定しない: 残席設定の列はマイグレーション適用前には無く、指定すると取得ごと失敗する
        const { data, error } = await supabase
            .from('forms')
            .select('*')
            .eq('id', id)
            .single()

        if (error || !data) {
            return NextResponse.json({ error: 'フォームが見つかりません' }, { status: 404 })
        }
        const form = data as Form

        if (!form.is_active) {
            return NextResponse.json({ error: 'このフォームは現在受付を停止しています' }, { status: 403 })
        }

        let availability = null
        if (form.capacity_enabled) {
            // キャンセル待ちの人がいれば、空いた席はその人たちの繰り上げ用なので両方数える
            const countByStatus = (status: 'confirmed' | 'waitlisted') =>
                supabase
                    .from('form_responses')
                    .select('id', { count: 'exact', head: true })
                    .eq('form_id', form.id)
                    .eq('entry_status', status)
            const [confirmed, waitlisted] = await Promise.all([
                countByStatus('confirmed'),
                countByStatus('waitlisted'),
            ])
            const countError = confirmed.error ?? waitlisted.error
            if (countError) {
                console.error('残席の集計エラー:', countError)
                return NextResponse.json({ error: '受付状況を確認できませんでした' }, { status: 500 })
            }
            availability = computeAvailability(form, confirmed.count ?? 0, waitlisted.count ?? 0)
        }

        return NextResponse.json({
            id: form.id,
            title: form.title,
            description: form.description,
            fields: form.fields ?? [],
            availability,
            // マイグレーション適用前は列が無いので、これまでどおり何度でも受け付ける
            onePerUser: form.one_response_per_user === true,
        })
    } catch (error) {
        console.error('フォーム取得エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
