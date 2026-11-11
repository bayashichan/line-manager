import type { Form, MessageContent } from '@/types'

/**
 * 申込フォームの自動返信（送信完了時・キャンセル待ち）の文面づくり。
 * LIFFのフォーム・管理画面・APIのどこからでも使えるよう、サーバー専用の依存を持たない。
 *
 * テキストでは次の差し込みが使える:
 * - {name}   申込者の名前
 * - {講座名} フォームの見出し（申込者がフォームで見た名前。見出しが空ならフォーム名）
 */

export const NAME_PLACEHOLDER = '{name}'
export const COURSE_NAME_PLACEHOLDER = '{講座名}'

export interface FormReplyVariables {
    /** 申込者の名前 */
    name: string
    /** 講座名（formCourseName で求める） */
    courseName: string
}

/**
 * 自動返信に差し込む講座名。
 * 申込者がフォームで見た「見出し」を使い、見出しが空ならフォーム名（管理用・必須）にする。
 */
export function formCourseName(form: Pick<Form, 'title' | 'name'>): string {
    return form.title?.trim() || form.name.trim()
}

/**
 * テキストの差し込みを置き換える。
 * 1回でまとめて置き換えるので、名前や講座名の中に「{講座名}」などが含まれていても、
 * それがさらに置き換わることはない。
 */
export function fillFormReplyText(text: string, vars: FormReplyVariables): string {
    return text.replace(/\{name\}|\{講座名\}/g, (token) =>
        token === NAME_PLACEHOLDER ? vars.name : vars.courseName
    )
}

/**
 * 保存済みの自動返信の定義をLINEメッセージ配列に変換する。
 * テキストは差し込みを置き換え、空要素は除外する。
 */
export function buildFormReplyMessages(content: MessageContent[], vars: FormReplyVariables): object[] {
    const messages: object[] = []
    for (const block of content) {
        if (block.type === 'text') {
            const text = fillFormReplyText(block.text || '', vars)
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
