import { describe, expect, it } from 'vitest'
import { UNKNOWN_DISPLAY_NAME } from '@/lib/line/display-name'
import { respondentLineName } from './respondent-line-user'

describe('respondentLineName', () => {
    it('友だち情報の名前（最新）を、申込時に控えた名前より優先する', () => {
        expect(respondentLineName({ line_display_name: 'やまだ' }, { display_name: 'ヤマダ' })).toBe('ヤマダ')
    })

    it('友だちでない人は、申込時に控えた名前を使う', () => {
        expect(respondentLineName({ line_display_name: 'やまだ' }, undefined)).toBe('やまだ')
    })

    it('友だち情報の名前が仮の名前・空なら、申込時に控えた名前を使う', () => {
        expect(respondentLineName({ line_display_name: 'やまだ' }, { display_name: UNKNOWN_DISPLAY_NAME })).toBe('やまだ')
        expect(respondentLineName({ line_display_name: 'やまだ' }, { display_name: null })).toBe('やまだ')
        expect(respondentLineName({ line_display_name: 'やまだ' }, { display_name: '  ' })).toBe('やまだ')
    })

    it('どちらにも名前が無ければ空文字（仮の名前も出さない）', () => {
        expect(respondentLineName({ line_display_name: null }, undefined)).toBe('')
        expect(respondentLineName({ line_display_name: null }, { display_name: UNKNOWN_DISPLAY_NAME })).toBe('')
    })

    it('マイグレーション適用前（列が無い）でも友だち情報の名前を返す', () => {
        const response = {} as { line_display_name: string | null }
        expect(respondentLineName(response, { display_name: 'ヤマダ' })).toBe('ヤマダ')
        expect(respondentLineName(response, undefined)).toBe('')
    })
})
