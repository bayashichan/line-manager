import { createAdminClient } from '@/lib/supabase/server'
import type { FormResponse } from '@/types'

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * 申込フォーム（LIFF）の申込者本人の特定と、本人の回答の取得（サーバー専用）。
 */

/**
 * LIFFアクセストークンを検証し、LINE userId を取得する。
 * verify で有効性・チャンネルを確認し、profile で userId を得る。
 */
export async function verifyLineAccessToken(
    accessToken: string
): Promise<{ userId: string; displayName: string } | null> {
    try {
        const verifyRes = await fetch(
            `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`
        )
        if (!verifyRes.ok) return null

        const verifyData = (await verifyRes.json()) as {
            client_id?: string
            expires_in?: number
        }
        if (!verifyData.expires_in || verifyData.expires_in <= 0) return null

        // client_id は参考ログのみ（フォーム用LIFFのログインチャンネルは
        // NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID と異なる場合があるため、ここでは弾かない）。
        // 本人特定はトークン有効性 + /v2/profile のuserId取得で担保する。
        const expectedClientId = process.env.NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID
        if (expectedClientId && verifyData.client_id && verifyData.client_id !== expectedClientId) {
            console.warn(
                `アクセストークンのclient_id(${verifyData.client_id})がNEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID(${expectedClientId})と異なります（処理は継続）`
            )
        }

        const profileRes = await fetch('https://api.line.me/v2/profile', {
            headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (!profileRes.ok) return null

        const profile = (await profileRes.json()) as {
            userId: string
            displayName: string
        }
        if (!profile.userId) return null

        return { userId: profile.userId, displayName: profile.displayName }
    } catch (err) {
        console.error('アクセストークン検証エラー:', err)
        return null
    }
}

/**
 * このフォームへの本人の申込を取得する。無ければ null。
 * 機能追加前に同じ人が複数回申し込んでいた場合は、最新の申込を返す（修正はそれを書き換える）。
 */
export async function findLatestOwnResponse(
    supabase: AdminClient,
    formId: string,
    lineUserId: string
): Promise<FormResponse | null> {
    // 列を指定しない: 追加した列はマイグレーション適用前には無く、指定すると取得ごと失敗する
    const { data, error } = await supabase
        .from('form_responses')
        .select('*')
        .eq('form_id', formId)
        .eq('line_user_id_raw', lineUserId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        throw new Error(`申込済みの回答の取得に失敗: ${error.message}`)
    }
    return (data as FormResponse | null) ?? null
}
