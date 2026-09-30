/**
 * 既存の中核ロジックの「今の動き」を固定するテスト（特性テスト）。
 *
 * L Harness の機能を取り込んでいく過程で、既存機能を壊していないことを確かめるための土台。
 * ここが落ちたら、既存の配信・自動応答・Webhookの挙動が変わったということ。
 */

import crypto from 'crypto'
import { describe, expect, it } from 'vitest'
import { calculateNextSendAt } from '@/lib/utils'
import { findMatchingAutoReply, personalizeContent } from '@/lib/line/auto-reply'
import {
    LineContentError,
    buildLineMessages,
    hasNamePlaceholder,
    replaceNamePlaceholder,
    toFlexAspectRatio,
} from '@/lib/line/message-content'
import { validateSignature } from '@/lib/line/client'
import type { AutoReply } from '@/types'

describe('calculateNextSendAt（ステップ配信の送信時刻・日本時間基準）', () => {
    // 2026-09-30 12:00 JST = 03:00 UTC
    const trigger = new Date('2026-09-30T03:00:00.000Z')

    it('時刻指定なしは開始から delay 分後', () => {
        expect(calculateNextSendAt(trigger, 0, null)).toBe('2026-09-30T03:00:00.000Z')
        expect(calculateNextSendAt(trigger, 30, null)).toBe('2026-09-30T03:30:00.000Z')
        expect(calculateNextSendAt(trigger, 1440, null)).toBe('2026-10-01T03:00:00.000Z')
    })

    it('N日後の指定時刻（日本時間）', () => {
        // 3日後 10:00 JST = 10/03 01:00 UTC
        expect(calculateNextSendAt(trigger, 3 * 1440, 10, 0)).toBe('2026-10-03T01:00:00.000Z')
        // 1日後 20:30 JST = 10/01 11:30 UTC
        expect(calculateNextSendAt(trigger, 1440, 20, 30)).toBe('2026-10-01T11:30:00.000Z')
    })

    it('当日の時刻がすでに過ぎていれば翌日', () => {
        // 当日 9:00 JST は開始（12:00 JST）より前 → 翌日 9:00 JST = 10/01 00:00 UTC
        expect(calculateNextSendAt(trigger, 0, 9, 0)).toBe('2026-10-01T00:00:00.000Z')
        // 当日 20:00 JST はまだ → 当日 = 09/30 11:00 UTC
        expect(calculateNextSendAt(trigger, 0, 20, 0)).toBe('2026-09-30T11:00:00.000Z')
    })

    it('日本時間の日付をまたぐ時間帯（UTCではまだ前日）でも日本時間の日付で数える', () => {
        // 2026-09-30 00:30 JST = 09/29 15:30 UTC、当日 10:00 JST = 09/30 01:00 UTC
        const lateNightUtc = new Date('2026-09-29T15:30:00.000Z')
        expect(calculateNextSendAt(lateNightUtc, 0, 10, 0)).toBe('2026-09-30T01:00:00.000Z')
    })
})

describe('findMatchingAutoReply（キーワード自動応答）', () => {
    const rule = (overrides: Partial<AutoReply>): AutoReply => ({
        id: overrides.id ?? 'r',
        channel_id: 'c',
        name: overrides.name ?? 'rule',
        keywords: overrides.keywords ?? ['料金'],
        match_type: overrides.match_type ?? 'partial',
        content: overrides.content ?? [{ type: 'text', text: '返信' }],
        priority: overrides.priority ?? 0,
        is_active: overrides.is_active ?? true,
        created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
    } as AutoReply)

    it('部分一致・大文字小文字と前後の空白を無視', () => {
        expect(findMatchingAutoReply([rule({ keywords: ['Price'] })], '  the PRICE is? ')?.id).toBe('r')
    })

    it('完全一致は全体が一致したときだけ', () => {
        const exact = rule({ match_type: 'exact', keywords: ['予約'] })
        expect(findMatchingAutoReply([exact], '予約')).not.toBeNull()
        expect(findMatchingAutoReply([exact], '予約したい')).toBeNull()
    })

    it('優先度が高い順、同じなら作成が古い順で1件だけ', () => {
        const rules = [
            rule({ id: 'low', priority: 0 }),
            rule({ id: 'high-new', priority: 5, created_at: '2026-02-01T00:00:00Z' }),
            rule({ id: 'high-old', priority: 5, created_at: '2026-01-01T00:00:00Z' }),
        ]
        expect(findMatchingAutoReply(rules, '料金を教えて')?.id).toBe('high-old')
    })

    it('無効・内容が空のルールは使わない', () => {
        expect(findMatchingAutoReply([rule({ is_active: false })], '料金')).toBeNull()
        expect(findMatchingAutoReply([rule({ content: [] })], '料金')).toBeNull()
        expect(findMatchingAutoReply([rule({})], '   ')).toBeNull()
    })

    it('{name} は表示名、なければ「友だち」', () => {
        expect(personalizeContent([{ type: 'text', text: '{name}さん' }], '山田')[0].text).toBe('山田さん')
        expect(personalizeContent([{ type: 'text', text: '{name}さん' }], null)[0].text).toBe('友だちさん')
    })
})

describe('buildLineMessages（管理画面のブロック → LINEのメッセージ）', () => {
    it('テキスト・画像・動画をそのまま変換', () => {
        expect(buildLineMessages([
            { type: 'text', text: 'こんにちは' },
            { type: 'image', originalContentUrl: 'https://cdn.example.com/a.png', previewImageUrl: 'https://cdn.example.com/a.png' },
            { type: 'video', originalContentUrl: 'https://cdn.example.com/v.mp4', previewImageUrl: 'https://cdn.example.com/v.jpg' },
        ])).toEqual([
            { type: 'text', text: 'こんにちは' },
            { type: 'image', originalContentUrl: 'https://cdn.example.com/a.png', previewImageUrl: 'https://cdn.example.com/a.png' },
            { type: 'video', originalContentUrl: 'https://cdn.example.com/v.mp4', previewImageUrl: 'https://cdn.example.com/v.jpg' },
        ])
    })

    it('URL遷移付き画像は Flex Message（uri アクション・スキーム補完）', () => {
        const [message] = buildLineMessages([{
            type: 'image',
            originalContentUrl: 'https://cdn.example.com/a.png',
            aspectRatio: 1.5,
            customActions: { redirectUrl: 'example.com/lp' },
        }])
        expect(message.type).toBe('flex')
        const image = message.contents.body.contents[0]
        expect(image.action).toEqual({ type: 'uri', uri: 'https://example.com/lp' })
        expect(image.aspectRatio).toBe('1500:1000')
    })

    it('タグ付与などのアクション付き画像は postback', () => {
        const [message] = buildLineMessages(
            [{ type: 'image', originalContentUrl: 'https://cdn.example.com/a.png', customActions: { tagIds: ['t1'] } }],
            { postbackData: 'action=custom&mid=m1' }
        )
        expect(message.contents.body.contents[0].action).toEqual({ type: 'postback', data: 'action=custom&mid=m1' })
    })

    it('LINEに弾かれる内容は送る前にエラー', () => {
        expect(() => buildLineMessages([])).toThrow(LineContentError)
        expect(() => buildLineMessages([{ type: 'text', text: '  ' }])).toThrow(LineContentError)
        expect(() => buildLineMessages([{ type: 'text', text: 'a'.repeat(5001) }])).toThrow(LineContentError)
        expect(() => buildLineMessages([{ type: 'image', originalContentUrl: 'http://cdn.example.com/a.png' }])).toThrow(LineContentError)
        expect(() => buildLineMessages([{ type: 'audio' }])).toThrow(LineContentError)
    })

    it('縦長すぎる画像は 1:3 に収める', () => {
        expect(toFlexAspectRatio(0.2)).toEqual({ aspectRatio: '1:3', aspectMode: 'fit' })
        expect(toFlexAspectRatio(undefined)).toEqual({ aspectMode: 'cover' })
    })

    it('{name} の置き換えと検出はテキストだけ', () => {
        const messages = buildLineMessages([{ type: 'text', text: '{name}さん' }])
        expect(hasNamePlaceholder(messages)).toBe(true)
        expect(replaceNamePlaceholder(messages, '花子')).toEqual([{ type: 'text', text: '花子さん' }])
        expect(replaceNamePlaceholder(messages, undefined)).toEqual([{ type: 'text', text: '友だちさん' }])
    })
})

describe('validateSignature（LINE Webhook の署名検証）', () => {
    const secret = 'channel-secret'
    const body = JSON.stringify({ destination: 'U', events: [] })
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64')

    it('正しい署名だけを通す', () => {
        expect(validateSignature(body, signature, secret)).toBe(true)
        expect(validateSignature(body + ' ', signature, secret)).toBe(false)
        expect(validateSignature(body, signature, 'other-secret')).toBe(false)
        expect(validateSignature(body, 'short', secret)).toBe(false)
        expect(validateSignature(body, '', secret)).toBe(false)
    })
})
