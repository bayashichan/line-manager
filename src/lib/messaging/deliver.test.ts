import { describe, expect, it } from 'vitest'
import type { LineClient } from '@/lib/line'
import { deliverToRecipients } from './deliver'
import type { Recipient } from './recipients'

const recipients = (count: number): Recipient[] =>
    Array.from({ length: count }, (_, i) => ({ id: `id${i}`, line_user_id: `U${i}`, display_name: `名前${i}` }))

/** 送った内容を控える偽の LINE。failFor の人・まとまりへの送信は失敗させる */
function createFakeLine(options: { failFor?: (to: string | string[]) => boolean; delayMs?: number } = {}) {
    const pushes: { to: string; messages: object[] }[] = []
    const multicasts: { to: string[]; messages: object[] }[] = []
    const concurrency = { now: 0, max: 0 }

    const client = {
        async pushMessage(to: string, messages: object[]) {
            concurrency.now++
            concurrency.max = Math.max(concurrency.max, concurrency.now)
            try {
                if (options.delayMs) await new Promise(r => setTimeout(r, options.delayMs))
                if (options.failFor?.(to)) throw new Error(`push failed: ${to}`)
                pushes.push({ to, messages })
            } finally {
                concurrency.now--
            }
        },
        async multicast(to: string[], messages: object[]) {
            if (options.failFor?.(to)) throw new Error('multicast failed')
            multicasts.push({ to, messages })
        },
    } as unknown as LineClient

    return { client, pushes, multicasts, concurrency }
}

describe('deliverToRecipients', () => {
    it('{name} がなければ500人ずつまとめて送る', async () => {
        const line = createFakeLine()
        const result = await deliverToRecipients(line.client, recipients(1200), [{ type: 'text', text: 'お知らせ' }])

        expect(line.multicasts.map(m => m.to.length)).toEqual([500, 500, 200])
        expect(line.pushes).toHaveLength(0)
        expect(result).toEqual({ successCount: 1200, failureCount: 0, firstError: null })
    })

    it('まとめて送れなかった分は失敗として数え、理由を残す', async () => {
        const line = createFakeLine({ failFor: to => Array.isArray(to) && to.includes('U500') })
        const result = await deliverToRecipients(line.client, recipients(1200), [{ type: 'text', text: 'お知らせ' }])

        expect(result).toEqual({ successCount: 700, failureCount: 500, firstError: 'multicast failed' })
    })

    it('{name} 入りは1人ずつ名前を差し込み、並行して送る', async () => {
        const line = createFakeLine({ delayMs: 2, failFor: to => to === 'U7' })
        const list = recipients(300)
        list[3] = { ...list[3], display_name: null }

        const result = await deliverToRecipients(line.client, list, [{ type: 'text', text: '{name}さん、こんにちは' }])

        expect(result).toEqual({ successCount: 299, failureCount: 1, firstError: 'push failed: U7' })
        expect(line.multicasts).toHaveLength(0)
        const textTo = (to: string) => (line.pushes.find(p => p.to === to)?.messages[0] as { text: string }).text
        expect(textTo('U0')).toBe('名前0さん、こんにちは')
        expect(textTo('U3')).toBe('友だちさん、こんにちは')
        // 10件ずつより多く並行し、LINE の上限には届かない
        expect(line.concurrency.max).toBeGreaterThan(10)
        expect(line.concurrency.max).toBeLessThanOrEqual(50)
    })
})
