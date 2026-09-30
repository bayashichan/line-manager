import { describe, expect, it } from 'vitest'
import { getAppBaseUrl } from './app-url'

const headers = (values: Record<string, string>) => new Headers(values)

describe('getAppBaseUrl（QStash などに呼び戻してもらう先）', () => {
    it('届いたリクエストの公開ドメインを使い、保護された VERCEL_URL は使わない', () => {
        expect(getAppBaseUrl(
            headers({ host: 'line-manager-abc123-team.vercel.app', 'x-forwarded-host': 'line-manager-omega.vercel.app', 'x-forwarded-proto': 'https' }),
            { VERCEL_URL: 'line-manager-abc123-team.vercel.app' }
        )).toBe('https://line-manager-omega.vercel.app')
    })

    it('APP_BASE_URL があれば最優先（末尾のスラッシュは除く）', () => {
        expect(getAppBaseUrl(headers({ host: 'x.vercel.app' }), { APP_BASE_URL: 'https://line.example.com/' }))
            .toBe('https://line.example.com')
    })

    it('ヘッダーがなければ Vercel の本番ドメイン', () => {
        expect(getAppBaseUrl(null, { VERCEL_PROJECT_PRODUCTION_URL: 'line.example.com', VERCEL_URL: 'protected.vercel.app' }))
            .toBe('https://line.example.com')
    })

    it('ローカルは http', () => {
        expect(getAppBaseUrl(headers({ host: 'localhost:3000' }), {})).toBe('http://localhost:3000')
    })
})
