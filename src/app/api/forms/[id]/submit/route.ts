import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { DEFAULT_WAITLIST_MESSAGE } from '@/lib/forms/capacity'
import { findLatestOwnResponse, verifyLineAccessToken } from '@/lib/forms/respondent'
import {
    buildEditedMessage,
    DUPLICATE_RESPONSE_ERROR,
    toMyFormResponse,
    type FormSubmitMode,
} from '@/lib/forms/resubmit'
import type { CompletionReplyStatus, Form, FormEntryStatus, FormField, FormResponse, MessageContent } from '@/types'

type CompletionReplyResult = {
    status: Exclude<CompletionReplyStatus, 'pending'>
    error: string | null
}

// 失敗理由として保存するエラー本文の上限（LINE APIのエラーは通常これより短い）
const ERROR_DETAIL_MAX = 1000

// 締切（close）設定のフォームが満席のとき、DBのトリガーが保存を拒否するメッセージ
// （supabase/migrations/20260929000000_add_form_capacity.sql）
const FORM_FULL_ERROR = 'FORM_FULL'

/**
 * 申込フォーム送信
 * POST /api/forms/[id]/submit
 *
 * リクエストボディ:
 * - accessToken: LIFFのアクセストークン（本人特定＆なりすまし防止のためサーバー側で検証）
 * - answers: { [fieldId]: string | string[] }
 * - mode: 'new'（既定）| 'update'（申込済みの内容を修正する。本人が確認したあとに送る）
 *
 * 処理:
 *  1. アクセストークンを検証してLINE userIdを確定
 *  2. 必須項目のバリデーション
 *  3. 1人1回までのフォームで申込済みなら、新しい申込にはしない
 *     - mode='new':    保存せず 409（duplicate）で申込内容を返す（LIFF側で修正するか聞く）
 *     - mode='update': 申込済みの回答を書き換え、修正の確認メッセージを送って終わる
 *       （申込状態・タグ・完了時の自動返信は最初の申込のまま）
 *  4. 回答を保存（残席設定がオンなら、DBのトリガーが定員から申込/キャンセル待ちを決める。
 *     締切設定で満席なら保存されず 409 を返す）
 *  5. 完了時の自動返信をpush（テキスト/画像・複数通、{name}差し込み対応）し、送信結果を回答に記録
 *     キャンセル待ちならキャンセル待ち用の自動返信を送る
 *  6. 完了タグ（キャンセル待ちならキャンセル待ち用のタグ）を付与し、必要ならリッチメニューを再判定
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params

    try {
        const { accessToken, answers, mode } = await request.json()
        const submitMode: FormSubmitMode = mode === 'update' ? 'update' : 'new'

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
        // 列を指定しない: 残席設定の列はマイグレーション適用前には無く、指定すると取得ごと失敗する
        const { data: formData, error: formError } = await supabase
            .from('forms')
            .select('*')
            .eq('id', id)
            .single()

        if (formError || !formData) {
            return NextResponse.json({ error: 'フォームが見つかりません' }, { status: 404 })
        }
        const form = formData as Form
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
        const name = lineUser?.display_name || displayName || '友だち'

        // --------------------------------------------------------------------
        // 1人1回までのフォーム: 申込済みの人は新しい申込にせず、確認のうえ修正として受け付ける
        // （マイグレーション適用前は列が無いので、これまでどおり何度でも受け付ける）
        // --------------------------------------------------------------------
        if (form.one_response_per_user === true) {
            const existing = await findLatestOwnResponse(supabase, form.id, userId)
            if (existing) {
                if (submitMode !== 'update') return duplicateResponse(existing)
                return await updateOwnResponse(supabase, form, existing, cleanAnswers, userId, name)
            }
            // 修正しようとしたが申込が見つからない（管理画面で削除されたなど）ときは、新しい申込として受け付ける
        }

        // --------------------------------------------------------------------
        // 回答を保存
        // --------------------------------------------------------------------
        // 自動返信の送信結果の列はここでは指定しない（DBの既定値で 'pending' になる）。
        // 申込状態(entry_status)も指定しない（DBのトリガーが定員から決める）。
        // マイグレーション適用前にデプロイされても、回答の保存は失敗させないため
        const { data: response, error: insertError } = await supabase
            .from('form_responses')
            .insert({
                form_id: form.id,
                channel_id: form.channel_id,
                line_user_id: lineUser?.id ?? null,
                line_user_id_raw: userId,
                answers: cleanAnswers,
            })
            .select('*')
            .single()

        // 同時に送られた同じ人の申込（送信ボタンの連打など）が先に保存された
        if (insertError?.message === DUPLICATE_RESPONSE_ERROR) {
            return duplicateResponse(await findLatestOwnResponse(supabase, form.id, userId))
        }
        if (insertError?.message === FORM_FULL_ERROR) {
            return NextResponse.json(
                { error: '定員に達したため、お申し込みの受付を終了しました', full: true },
                { status: 409 }
            )
        }
        if (insertError || !response) {
            console.error('回答保存エラー:', insertError)
            return NextResponse.json({ error: '回答の保存に失敗しました' }, { status: 500 })
        }

        // 送信元チャンネルのアクセストークンを取得（自動返信push用）
        const { data: channel } = await supabase
            .from('channels')
            .select('channel_access_token')
            .eq('id', form.channel_id)
            .single()

        // マイグレーション適用前は列が無いので、通常の申込として扱う
        const entryStatus: FormEntryStatus =
            response.entry_status === 'waitlisted' ? 'waitlisted' : 'confirmed'
        const waitlisted = entryStatus === 'waitlisted'

        // --------------------------------------------------------------------
        // 完了時の自動返信を送信し、結果を回答に記録する（管理画面で確認するため）
        // キャンセル待ちには「申込完了」の文面ではなく、キャンセル待ち用の文面を送る
        // --------------------------------------------------------------------
        const completionContent: MessageContent[] = waitlisted
            ? [{ type: 'text', text: form.waitlist_message?.trim() || DEFAULT_WAITLIST_MESSAGE }]
            : (form.completion_message ?? [])
        const messages = buildCompletionMessages(completionContent, name)
        let replyResult: CompletionReplyResult
        if (messages.length === 0) {
            replyResult = { status: 'skipped', error: '自動返信メッセージが設定されていません' }
        } else if (!channel?.channel_access_token) {
            replyResult = { status: 'skipped', error: 'LINE公式アカウントのアクセストークンが設定されていません' }
        } else {
            try {
                await new LineClient(channel.channel_access_token).pushMessage(userId, messages)
                replyResult = { status: 'sent', error: null }
            } catch (err) {
                // 自動返信の失敗は申込自体を失敗にはしない（回答は保存済み）
                console.error(`完了自動返信エラー (userId: ${userId}):`, err)
                const detail = err instanceof Error ? err.message : String(err)
                replyResult = { status: 'failed', error: detail.slice(0, ERROR_DETAIL_MAX) }
            }
        }

        const { error: replyLogError } = await supabase
            .from('form_responses')
            .update({
                completion_reply_status: replyResult.status,
                completion_reply_error: replyResult.error,
                completion_reply_at: new Date().toISOString(),
            })
            .eq('id', response.id)
        if (replyLogError) {
            console.error(`完了自動返信の結果を記録できませんでした (responseId: ${response.id}):`, replyLogError)
        }

        // --------------------------------------------------------------------
        // 完了タグ付与＋リッチメニュー再判定
        // キャンセル待ちには完了タグではなく、キャンセル待ち用のタグを付ける
        // --------------------------------------------------------------------
        const tagIds = (waitlisted ? form.waitlist_tag_ids : form.completion_tag_ids) ?? []
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

        return NextResponse.json({ success: true, entryStatus })
    } catch (error) {
        console.error('フォーム送信エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}

/**
 * 申込済みの人からの新しい申込への応答。
 * 保存はせず、今の申込内容を返す（LIFF側で「申込済みです。内容を修正しますか？」と聞く）。
 */
function duplicateResponse(existing: FormResponse | null) {
    return NextResponse.json(
        {
            error: 'このフォームには既にお申し込みいただいています',
            duplicate: true,
            response: existing ? toMyFormResponse(existing) : null,
        },
        { status: 409 }
    )
}

/**
 * 申込済みの回答を、本人が修正した内容で書き換える。
 * 申込状態（席）・タグ・完了時の自動返信の記録は最初の申込のまま変えない。
 * 修正を受け付けたことと修正後の内容を、本人のトークへ送る（失敗しても修正は完了扱い）。
 */
async function updateOwnResponse(
    supabase: ReturnType<typeof createAdminClient>,
    form: Form,
    existing: FormResponse,
    answers: Record<string, string | string[]>,
    userId: string,
    name: string
) {
    const { error: updateError } = await supabase
        .from('form_responses')
        .update({ answers, edited_at: new Date().toISOString() })
        .eq('id', existing.id)

    if (updateError) {
        console.error(`申込内容の修正エラー (responseId: ${existing.id}):`, updateError)
        return NextResponse.json({ error: '申込内容の修正に失敗しました' }, { status: 500 })
    }

    const { data: channel } = await supabase
        .from('channels')
        .select('channel_access_token')
        .eq('id', form.channel_id)
        .single()

    if (channel?.channel_access_token) {
        try {
            const text = buildEditedMessage(name, form.fields ?? [], answers)
            await new LineClient(channel.channel_access_token).pushMessage(userId, [{ type: 'text', text }])
        } catch (err) {
            console.error(`修正の確認メッセージの送信エラー (userId: ${userId}):`, err)
        }
    }

    return NextResponse.json({
        success: true,
        updated: true,
        entryStatus: toMyFormResponse(existing).entryStatus,
    })
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
