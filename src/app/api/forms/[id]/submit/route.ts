import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import type { FormField, MessageContent } from '@/types'

/**
 * 申込フォーム送信
 * POST /api/forms/[id]/submit
 *
 * リクエストボディ:
 * - accessToken: LIFFのアクセストークン（本人特定＆なりすまし防止のためサーバー側で検証）
 * - answers: { [fieldId]: string | string[] }
 *
 * 処理:
 *  1. アクセストークンを検証してLINE userIdを確定
 *  2. 必須項目のバリデーション
 *  3. 回答を保存
 *  4. 完了時の自動返信をpush（テキスト/画像・複数通、{name}差し込み対応）
 *  5. 完了タグを付与し、必要ならリッチメニューを再判定
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params

    try {
        const { accessToken, answers } = await request.json()

        if (!accessToken) {
            return NextResponse.json({ error: 'アクセストークンがありません' }, { status: 400 })
        }
        if (!answers || typeof answers !== 'object') {
            return NextResponse.json({ error: '回答がありません' }, { status: 400 })
        }

        const supabase = createAdminClient()

        // --------------------------------------------------------------------
        // フォーム定義を取得
        // --------------------------------------------------------------------
        const { data: form, error: formError } = await supabase
            .from('forms')
            .select('id, channel_id, fields, completion_message, completion_tag_ids, is_active')
            .eq('id', id)
            .single()

        if (formError || !form) {
            return NextResponse.json({ error: 'フォームが見つかりません' }, { status: 404 })
        }
        if (!form.is_active) {
            return NextResponse.json({ error: 'このフォームは現在受付を停止しています' }, { status: 403 })
        }

        // --------------------------------------------------------------------
        // アクセストークン検証 → LINE userId 確定（なりすまし防止）
        // --------------------------------------------------------------------
        const verified = await verifyLineAccessToken(accessToken)
        if (!verified) {
            return NextResponse.json({ error: 'ユーザー認証に失敗しました' }, { status: 401 })
        }
        const { userId, displayName } = verified

        // --------------------------------------------------------------------
        // 必須項目バリデーション
        // --------------------------------------------------------------------
        const fields = (form.fields ?? []) as FormField[]
        for (const field of fields) {
            if (!field.required) continue
            const value = answers[field.id]
            const isEmpty =
                value === undefined ||
                value === null ||
                (typeof value === 'string' && value.trim() === '') ||
                (Array.isArray(value) && value.length === 0)
            if (isEmpty) {
                return NextResponse.json(
                    { error: `「${field.label}」は必須項目です` },
                    { status: 400 }
                )
            }
        }

        // 定義に存在する項目のみ保存（不要データの混入を防ぐ）
        const cleanAnswers: Record<string, string | string[]> = {}
        for (const field of fields) {
            if (answers[field.id] !== undefined) {
                cleanAnswers[field.id] = answers[field.id]
            }
        }

        // --------------------------------------------------------------------
        // 内部ユーザー(line_users)を解決
        // --------------------------------------------------------------------
        const { data: lineUser } = await supabase
            .from('line_users')
            .select('id, display_name')
            .eq('channel_id', form.channel_id)
            .eq('line_user_id', userId)
            .maybeSingle()

        // --------------------------------------------------------------------
        // 回答を保存
        // --------------------------------------------------------------------
        const { error: insertError } = await supabase.from('form_responses').insert({
            form_id: form.id,
            channel_id: form.channel_id,
            line_user_id: lineUser?.id ?? null,
            line_user_id_raw: userId,
            answers: cleanAnswers,
        })

        if (insertError) {
            console.error('回答保存エラー:', insertError)
            return NextResponse.json({ error: '回答の保存に失敗しました' }, { status: 500 })
        }

        // 送信元チャンネルのアクセストークンを取得（自動返信push用）
        const { data: channel } = await supabase
            .from('channels')
            .select('channel_access_token')
            .eq('id', form.channel_id)
            .single()

        // --------------------------------------------------------------------
        // 完了時の自動返信を送信
        // --------------------------------------------------------------------
        if (channel?.channel_access_token) {
            const lineClient = new LineClient(channel.channel_access_token)
            const name = lineUser?.display_name || displayName || '友だち'
            const messages = buildCompletionMessages(
                (form.completion_message ?? []) as MessageContent[],
                name
            )
            if (messages.length > 0) {
                try {
                    await lineClient.pushMessage(userId, messages)
                } catch (err) {
                    // 自動返信の失敗は申込自体を失敗にはしない（回答は保存済み）
                    console.error(`完了自動返信エラー (userId: ${userId}):`, err)
                }
            }
        }

        // --------------------------------------------------------------------
        // 完了タグ付与＋リッチメニュー再判定
        // --------------------------------------------------------------------
        const tagIds = (form.completion_tag_ids ?? []) as string[]
        if (lineUser?.id && tagIds.length > 0) {
            try {
                const tagInserts = tagIds.map((tagId) => ({
                    line_user_id: lineUser.id,
                    tag_id: tagId,
                }))
                await supabase
                    .from('line_user_tags')
                    .upsert(tagInserts, { onConflict: 'line_user_id,tag_id' })

                const { recalculateAndSwitchUserRichMenu } = await import('@/lib/rich-menu')
                await recalculateAndSwitchUserRichMenu(lineUser.id)
            } catch (err) {
                console.error(`完了タグ付与エラー (userId: ${userId}):`, err)
            }
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('フォーム送信エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}

/**
 * LIFFアクセストークンを検証し、LINE userId を取得する。
 * verify で有効性・チャンネルを確認し、profile で userId を得る。
 */
async function verifyLineAccessToken(
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
 * 保存済みの完了メッセージ定義をLINEメッセージ配列に変換する。
 * テキストは {name} を差し込み、空要素は除外する。
 */
function buildCompletionMessages(
    content: MessageContent[],
    name: string
): object[] {
    const messages: object[] = []
    for (const block of content) {
        if (block.type === 'text') {
            const text = (block.text || '').replace(/{name}/g, name)
            if (text.trim()) messages.push({ type: 'text', text })
        } else if (block.type === 'image') {
            const url = block.originalContentUrl || block.previewImageUrl
            if (url) {
                messages.push({
                    type: 'image',
                    originalContentUrl: url,
                    previewImageUrl: block.previewImageUrl || url,
                })
            }
        }
    }
    return messages
}
