import { describe, expect, it } from 'vitest'
import { DEFAULT_WAITLIST_MESSAGE } from './capacity'
import { buildFormReplyMessages, fillFormReplyText, formCourseName } from './reply'

describe('formCourseName', () => {
    it('申込者に見せている見出しを使う', () => {
        expect(formCourseName({ title: ' 秋のヨガ入門講座 ', name: 'ヨガ申込_管理用' })).toBe('秋のヨガ入門講座')
    })

    it('見出しが空ならフォーム名を使う', () => {
        expect(formCourseName({ title: null, name: 'ヨガ入門講座' })).toBe('ヨガ入門講座')
        expect(formCourseName({ title: '  ', name: 'ヨガ入門講座' })).toBe('ヨガ入門講座')
    })
})

describe('fillFormReplyText', () => {
    const vars = { name: '山田', courseName: 'ヨガ入門講座' }

    it('{name} と {講座名} を何回でも置き換える', () => {
        expect(fillFormReplyText('{name}さん、{講座名}／{講座名}', vars)).toBe('山田さん、ヨガ入門講座／ヨガ入門講座')
    })

    it('名前や講座名に含まれる差し込みの文字は、さらに置き換えない', () => {
        expect(fillFormReplyText('{name}：{講座名}', { name: '{講座名}', courseName: '{name}講座' })).toBe(
            '{講座名}：{name}講座'
        )
    })

    it('既定のキャンセル待ちの文面に講座名が入る', () => {
        expect(fillFormReplyText(DEFAULT_WAITLIST_MESSAGE, vars)).toBe(
            '山田さん、お申し込みありがとうございます。\n' +
                '「ヨガ入門講座」は定員に達したため、キャンセル待ちとして受け付けました。\n' +
                'お席に空きが出ましたら、あらためてご連絡いたします。'
        )
    })
})

describe('buildFormReplyMessages', () => {
    it('テキストは差し込みを置き換え、空のテキストやURLのない画像は送らない', () => {
        const messages = buildFormReplyMessages(
            [
                { type: 'text', text: '{name}さん、「{講座名}」のお申し込みを受け付けました' },
                { type: 'text', text: '   ' },
                { type: 'image', originalContentUrl: 'https://example.com/a.png' },
                { type: 'image' },
            ],
            { name: '山田', courseName: 'ヨガ入門講座' }
        )
        expect(messages).toEqual([
            { type: 'text', text: '山田さん、「ヨガ入門講座」のお申し込みを受け付けました' },
            {
                type: 'image',
                originalContentUrl: 'https://example.com/a.png',
                previewImageUrl: 'https://example.com/a.png',
            },
        ])
    })
})
