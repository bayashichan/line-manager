import { MAX_TEXT_LENGTH } from '@/lib/line/auto-reply'
import type { FormEntryStatus, FormField, FormResponse } from '@/types'

/**
 * 申込フォームの重複申込の防止と、申込者本人による内容の修正まわりの共通処理。
 * LIFFのフォーム・APIのどこからでも使えるよう、サーバー専用の依存を持たない。
 *
 * 1人1回までのフォーム（forms.one_response_per_user）では、同じ人（LINEのuserId）の
 * 2回目以降の申込を新しい回答にせず、「申込内容を修正しますか？」と確認してから
 * 既存の回答を書き換える。
 */

type AnswerValue = string | string[]

/** 申込者本人に見せる、本人の申込（他人の回答や内部IDは含めない） */
export interface MyFormResponse {
    id: string
    answers: Record<string, AnswerValue>
    entryStatus: FormEntryStatus
    createdAt: string
    editedAt: string | null
}

/**
 * 申込の送信モード
 * - new:    新しい申込（申込済みなら保存せず、修正するか確認する）
 * - update: 申込済みの内容を修正する（本人が確認したあと）
 */
export type FormSubmitMode = 'new' | 'update'

/** 申込済みの人の2回目以降の申込を、DBのトリガーが拒否するときのメッセージ */
export const DUPLICATE_RESPONSE_ERROR = 'DUPLICATE_RESPONSE'

// 修正の確認メッセージに載せる回答1件あたりの上限（長文の回答で他の項目が埋もれないように）
const SUMMARY_VALUE_MAX = 300

export function toMyFormResponse(
    row: Pick<FormResponse, 'id' | 'answers' | 'entry_status' | 'created_at' | 'edited_at'>
): MyFormResponse {
    return {
        id: row.id,
        answers: row.answers ?? {},
        // マイグレーション適用前の回答には申込状態が無いので、通常の申込として扱う
        entryStatus: row.entry_status === 'waitlisted' ? 'waitlisted' : 'confirmed',
        createdAt: row.created_at,
        editedAt: row.edited_at ?? null,
    }
}

/** 回答1件を表示用の文字列にする（チェックボックスは「、」区切り） */
export function answerToText(value: AnswerValue | null | undefined): string {
    if (value === undefined || value === null) return ''
    return Array.isArray(value) ? value.join('、') : String(value)
}

/**
 * 申込内容を修正したときに本人へ送る確認メッセージ。
 * 修正後の内容を載せ、本人がトーク画面で見直せるようにする。未回答の項目は省く。
 */
export function buildEditedMessage(
    name: string,
    fields: FormField[],
    answers: Record<string, AnswerValue>
): string {
    const lines = fields
        .map((field) => {
            const text = answerToText(answers[field.id]).trim()
            if (!text) return null
            const value = text.length > SUMMARY_VALUE_MAX ? `${text.slice(0, SUMMARY_VALUE_MAX)}…` : text
            return `${field.label}：${value}`
        })
        .filter((line): line is string => line !== null)

    const header = `${name}さん、お申し込み内容の修正を受け付けました。`
    const message = lines.length > 0 ? `${header}\n\n【修正後の内容】\n${lines.join('\n')}` : header
    return message.length > MAX_TEXT_LENGTH ? `${message.slice(0, MAX_TEXT_LENGTH - 1)}…` : message
}
