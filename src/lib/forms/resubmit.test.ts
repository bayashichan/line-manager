import { describe, expect, it } from 'vitest'
import { MAX_TEXT_LENGTH } from '@/lib/line/auto-reply'
import type { FormField } from '@/types'
import { answerToText, buildEditedMessage, toMyFormResponse } from './resubmit'

const fields: FormField[] = [
    { id: 'name', label: 'お名前', type: 'text', required: true },
    { id: 'date', label: 'ご希望日', type: 'select', required: true, options: ['10/3', '10/4'] },
    { id: 'topics', label: '相談したいこと', type: 'checkbox', required: false, options: ['キャリア', '組織'] },
    { id: 'note', label: '備考', type: 'textarea', required: false },
]

describe('answerToText', () => {
    it('チェックボックスは「、」でつなぐ', () => {
        expect(answerToText(['キャリア', '組織'])).toBe('キャリア、組織')
    })

    it('未回答は空文字', () => {
        expect(answerToText(undefined)).toBe('')
        expect(answerToText(null)).toBe('')
    })
})

describe('buildEditedMessage', () => {
    it('修正後の内容を項目の順に載せ、未回答の項目は省く', () => {
        const text = buildEditedMessage('山田', fields, {
            topics: ['キャリア', '組織'],
            name: '山田太郎',
            date: '10/4',
            note: '  ',
        })
        expect(text).toBe(
            '山田さん、お申し込み内容の修正を受け付けました。\n\n' +
            '【修正後の内容】\n' +
            'お名前：山田太郎\n' +
            'ご希望日：10/4\n' +
            '相談したいこと：キャリア、組織'
        )
    })

    it('フォームの定義に無い項目は載せない', () => {
        const text = buildEditedMessage('山田', fields, { name: '山田太郎', removed: '古い項目' })
        expect(text).not.toContain('古い項目')
    })

    it('載せる項目が無ければ受付の一文だけ', () => {
        expect(buildEditedMessage('山田', fields, {})).toBe('山田さん、お申し込み内容の修正を受け付けました。')
    })

    it('長い回答は切り詰め、全体もLINEの1吹き出しの上限に収める', () => {
        const manyFields: FormField[] = Array.from({ length: 30 }, (_, i) => ({
            id: `f${i}`,
            label: `項目${i}`,
            type: 'textarea',
            required: false,
        }))
        const answers = Object.fromEntries(manyFields.map((f) => [f.id, 'あ'.repeat(1000)]))
        const text = buildEditedMessage('山田', manyFields, answers)

        expect(text).toContain(`項目0：${'あ'.repeat(300)}…\n`)
        expect(text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH)
    })
})

describe('toMyFormResponse', () => {
    it('本人に見せる項目だけにする', () => {
        const mine = toMyFormResponse({
            id: 'r1',
            answers: { name: '山田太郎' },
            entry_status: 'waitlisted',
            created_at: '2026-09-30T01:00:00Z',
            edited_at: '2026-09-30T02:00:00Z',
        })
        expect(mine).toEqual({
            id: 'r1',
            answers: { name: '山田太郎' },
            entryStatus: 'waitlisted',
            createdAt: '2026-09-30T01:00:00Z',
            editedAt: '2026-09-30T02:00:00Z',
        })
    })

    it('マイグレーション適用前の回答（申込状態・修正日時の列が無い）は、修正なしの通常の申込として扱う', () => {
        const mine = toMyFormResponse({
            id: 'r1',
            answers: {},
            created_at: '2026-09-30T01:00:00Z',
        } as unknown as Parameters<typeof toMyFormResponse>[0])
        expect(mine.entryStatus).toBe('confirmed')
        expect(mine.editedAt).toBeNull()
    })
})
