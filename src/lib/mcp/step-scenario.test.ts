import { describe, expect, it } from 'vitest'
import { buildStepRows, describeStepTiming, parseSendTime, StepInputError } from './step-scenario'

describe('parseSendTime', () => {
    it('HH:MM を分解する', () => {
        expect(parseSendTime('10:00')).toEqual({ hour: 10, minute: 0 })
        expect(parseSendTime('7:05')).toEqual({ hour: 7, minute: 5 })
        expect(parseSendTime('23:59')).toEqual({ hour: 23, minute: 59 })
    })

    it('空なら時刻指定なし', () => {
        expect(parseSendTime(undefined)).toBeNull()
        expect(parseSendTime(null)).toBeNull()
        expect(parseSendTime('')).toBeNull()
    })

    it('不正な形式はエラー', () => {
        expect(() => parseSendTime('24:00')).toThrow(StepInputError)
        expect(() => parseSendTime('10時')).toThrow(StepInputError)
    })
})

describe('buildStepRows', () => {
    it('管理画面と同じ形（N日×1440分・送信時刻・contentブロック）に変換する', () => {
        const rows = buildStepRows([
            { days_after: 0, messages: [{ type: 'text', text: '{name}さん、登録ありがとうございます' }] },
            {
                days_after: 3,
                send_time: '10:30',
                messages: [
                    { type: 'text', text: '3日目です' },
                    { type: 'image', image_url: 'https://cdn.example.com/a.png' },
                ],
            },
        ])

        expect(rows).toEqual([
            {
                step_order: 1,
                delay_minutes: 0,
                send_hour: null,
                send_minute: 0,
                content: [{ type: 'text', text: '{name}さん、登録ありがとうございます' }],
            },
            {
                step_order: 2,
                delay_minutes: 3 * 1440,
                send_hour: 10,
                send_minute: 30,
                content: [
                    { type: 'text', text: '3日目です' },
                    {
                        type: 'image',
                        originalContentUrl: 'https://cdn.example.com/a.png',
                        previewImageUrl: 'https://cdn.example.com/a.png',
                    },
                ],
            },
        ])
    })

    it('配信日時の早い順に並べ替えて step_order を振り直す', () => {
        const rows = buildStepRows([
            { days_after: 7, send_time: '20:00', messages: [{ type: 'text', text: 'C' }] },
            { days_after: 1, send_time: '20:00', messages: [{ type: 'text', text: 'B' }] },
            { days_after: 1, send_time: '09:00', messages: [{ type: 'text', text: 'A' }] },
        ])
        expect(rows.map(r => [r.step_order, (r.content[0] as { text: string }).text])).toEqual([
            [1, 'A'],
            [2, 'B'],
            [3, 'C'],
        ])
    })

    it('動画はサムネイル付きで保存する', () => {
        const [row] = buildStepRows([{
            days_after: 1,
            messages: [{ type: 'video', video_url: 'https://cdn.example.com/v.mp4', preview_image_url: 'https://cdn.example.com/v.jpg' }],
        }])
        expect(row.content[0]).toEqual({
            type: 'video',
            originalContentUrl: 'https://cdn.example.com/v.mp4',
            previewImageUrl: 'https://cdn.example.com/v.jpg',
        })
    })

    it('LINE の制約に合わない入力はステップ番号付きでエラーにする', () => {
        expect(() => buildStepRows([])).toThrow('ステップを1つ以上')
        expect(() => buildStepRows([{ days_after: 1, messages: [] }])).toThrow('ステップ1')
        expect(() => buildStepRows([{ days_after: 1, messages: [{ type: 'text', text: '   ' }] }])).toThrow('空のテキスト')
        expect(() => buildStepRows([{ days_after: 1, messages: [{ type: 'image', image_url: 'http://x.example.com/a.png' }] }]))
            .toThrow('https')
        expect(() => buildStepRows([{ days_after: 1.5, messages: [{ type: 'text', text: 'a' }] }])).toThrow('整数')
        expect(() => buildStepRows([{
            days_after: 1,
            messages: Array.from({ length: 6 }, () => ({ type: 'text' as const, text: 'a' })),
        }])).toThrow('5個まで')
        expect(() => buildStepRows([
            { days_after: 0, messages: [{ type: 'text', text: 'ok' }] },
            { days_after: 2, send_time: '25:00', messages: [{ type: 'text', text: 'a' }] },
        ])).toThrow('ステップ2')
    })
})

describe('describeStepTiming', () => {
    it('人が読める表記にする', () => {
        expect(describeStepTiming(0, null, 0)).toBe('即時（開始直後）')
        expect(describeStepTiming(0, 20, 0)).toBe('当日 20:00（過ぎていれば翌日）')
        expect(describeStepTiming(3 * 1440, 10, 5)).toBe('3日後 10:05')
        expect(describeStepTiming(2 * 1440, null, 0)).toBe('2日後（開始時刻から48時間後）')
    })
})
