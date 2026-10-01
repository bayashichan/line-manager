/**
 * 申込フォームから届く管理用ネーム・タグの整え方。
 */

import { describe, expect, it } from 'vitest'
import { normalizeApplicantProfile } from '@/lib/applicants'

describe('normalizeApplicantProfile', () => {
    it('外すタグは、付けるタグと同じ整え方をする', () => {
        const profile = normalizeApplicantProfile({
            internalName: '花\nの部屋',
            tagNames: [' 第7回出展者 ', '第7回出展者'],
            removeTagNames: ['第7回  キャンセル待ち', '', 3],
        })

        expect(profile).toEqual({
            internalName: '花 の部屋',
            tagNames: ['第7回出展者'],
            removeTagNames: ['第7回 キャンセル待ち'],
        })
    })

    it('付けるタグと同じ名前は外さない', () => {
        const profile = normalizeApplicantProfile({
            tagNames: ['第7回出展者'],
            removeTagNames: ['第7回出展者', '第7回キャンセル待ち'],
        })

        expect(profile.removeTagNames).toEqual(['第7回キャンセル待ち'])
    })

    it('外すタグが無ければ空（従来の申込はそのまま）', () => {
        expect(normalizeApplicantProfile({ tagNames: ['第7回出展者'] }).removeTagNames).toEqual([])
    })
})
