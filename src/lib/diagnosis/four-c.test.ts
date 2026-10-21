import { describe, expect, it } from 'vitest'
import { fourCTagNames, isAllowedFourCOrigin, parseFourCResult } from './four-c'

describe('parseFourCResult', () => {
    it('正しい本文を受け取る', () => {
        expect(parseFourCResult({ stage: 'mini', goal: 2, brake: true })).toEqual({ stage: 'mini', goal: 2, brake: true })
    })
    it('知らない段階や範囲外の目標は受け取らない', () => {
        expect(parseFourCResult({ stage: 'big', goal: 2, brake: false })).toBeNull()
        expect(parseFourCResult({ stage: 'mini', goal: 4, brake: false })).toBeNull()
        expect(parseFourCResult({ stage: 'mini', goal: 1.5, brake: false })).toBeNull()
        expect(parseFourCResult(null)).toBeNull()
    })
})

describe('fourCTagNames', () => {
    it('ミニcでプロcを目指す人には差のタグが付く', () => {
        expect(fourCTagNames({ stage: 'mini', goal: 2, brake: false })).toEqual(['4C診断済み', '4C_ミニc（育っている）', '4C_差2段階以上'])
    })
    it('差が1段階ならつかず、ブレーキがあれば付く', () => {
        expect(fourCTagNames({ stage: 'little', goal: 2, brake: true })).toEqual(['4C診断済み', '4C_リトルc', '4C_ブレーキあり'])
    })
})

describe('isAllowedFourCOrigin', () => {
    it('本番とプレビューだけを許可する', () => {
        expect(isAllowedFourCOrigin('https://updatehayashi.jp')).toBe(true)
        expect(isAllowedFourCOrigin('https://claude-4c-check.voiceanalysis-ce1.pages.dev')).toBe(true)
        expect(isAllowedFourCOrigin('https://evil.example.com')).toBe(false)
        expect(isAllowedFourCOrigin(null)).toBe(false)
    })
})
