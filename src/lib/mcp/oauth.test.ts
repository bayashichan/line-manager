import crypto from 'crypto'
import { describe, expect, it } from 'vitest'
import {
    buildAuthorizationServerMetadata,
    buildProtectedResourceMetadata,
    buildRedirectUrl,
    getBaseUrl,
    isAllowedRedirectUri,
    parseBasicAuth,
    parseBearerToken,
    redirectUriMatches,
    validateAuthorizeParams,
    verifyPkceS256,
} from './oauth'

function headers(values: Record<string, string>) {
    return new Headers(values)
}

describe('verifyPkceS256', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    // RFC 7636 Appendix B の例
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

    it('RFC 7636 の例を検証できる', () => {
        expect(verifyPkceS256(verifier, challenge)).toBe(true)
    })

    it('違う verifier は通さない', () => {
        expect(verifyPkceS256(verifier.replace('d', 'e'), challenge)).toBe(false)
    })

    it('短すぎる verifier は通さない', () => {
        const short = 'abc'
        const shortChallenge = crypto.createHash('sha256').update(short).digest('base64url')
        expect(verifyPkceS256(short, shortChallenge)).toBe(false)
    })
})

describe('isAllowedRedirectUri', () => {
    it('Claude の戻り先を受け付ける', () => {
        expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback', [])).toBe(true)
        expect(isAllowedRedirectUri('https://claude.com/api/mcp/auth_callback', [])).toBe(true)
    })

    it('Claude Code のループバック（ポート任意）を受け付ける', () => {
        expect(isAllowedRedirectUri('http://localhost:3118/callback', [])).toBe(true)
        expect(isAllowedRedirectUri('http://127.0.0.1/callback', [])).toBe(true)
    })

    it('知らない https の戻り先は拒否する', () => {
        expect(isAllowedRedirectUri('https://evil.example.com/callback', [])).toBe(false)
        expect(isAllowedRedirectUri('https://claude.ai.evil.example.com/api/mcp/auth_callback', [])).toBe(false)
    })

    it('ループバック以外の http は拒否する', () => {
        expect(isAllowedRedirectUri('http://example.com/callback', [])).toBe(false)
    })

    it('環境変数で許可したURLは受け付ける', () => {
        expect(isAllowedRedirectUri('https://example.com/cb', ['https://example.com/cb'])).toBe(true)
    })

    it('フラグメント付きや不正なURLは拒否する', () => {
        expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback#x', [])).toBe(false)
        expect(isAllowedRedirectUri('not a url', [])).toBe(false)
    })
})

describe('redirectUriMatches', () => {
    it('完全一致なら true', () => {
        expect(redirectUriMatches(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/api/mcp/auth_callback')).toBe(true)
    })

    it('ループバックはポートを無視して比べる', () => {
        expect(redirectUriMatches(['http://localhost/callback'], 'http://localhost:51234/callback')).toBe(true)
        expect(redirectUriMatches(['http://127.0.0.1:1111/callback'], 'http://127.0.0.1:2222/callback')).toBe(true)
    })

    it('ループバックでもパスやホストが違えば false', () => {
        expect(redirectUriMatches(['http://localhost/callback'], 'http://localhost:51234/other')).toBe(false)
        expect(redirectUriMatches(['http://localhost/callback'], 'http://127.0.0.1:51234/callback')).toBe(false)
    })

    it('https はポートやパスの違いを許さない', () => {
        expect(redirectUriMatches(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/api/mcp/auth_callback2')).toBe(false)
    })
})

describe('getBaseUrl', () => {
    it('プロキシのヘッダーを優先する', () => {
        expect(getBaseUrl(headers({ host: 'internal', 'x-forwarded-host': 'app.example.com', 'x-forwarded-proto': 'https' }), undefined))
            .toBe('https://app.example.com')
    })

    it('localhost は http とみなす', () => {
        expect(getBaseUrl(headers({ host: 'localhost:3000' }), undefined)).toBe('http://localhost:3000')
    })

    it('上書き設定があればそれを使う（末尾スラッシュは除く）', () => {
        expect(getBaseUrl(headers({ host: 'x' }), 'https://line.example.com/')).toBe('https://line.example.com')
    })
})

describe('metadata', () => {
    it('resource は MCP の URL と一致する', () => {
        expect(buildProtectedResourceMetadata('https://app.example.com')).toMatchObject({
            resource: 'https://app.example.com/api/mcp',
            authorization_servers: ['https://app.example.com'],
        })
    })

    it('認可サーバーは PKCE S256 と動的登録を公開する', () => {
        const meta = buildAuthorizationServerMetadata('https://app.example.com')
        expect(meta.code_challenge_methods_supported).toEqual(['S256'])
        expect(meta.registration_endpoint).toBe('https://app.example.com/api/oauth/register')
        expect(meta.token_endpoint_auth_methods_supported).toContain('none')
    })
})

describe('parseBasicAuth / parseBearerToken', () => {
    it('Basic ヘッダーを分解する', () => {
        const value = Buffer.from('client%3A1:se%20cret').toString('base64')
        expect(parseBasicAuth(`Basic ${value}`)).toEqual({ clientId: 'client:1', clientSecret: 'se cret' })
    })

    it('Bearer トークンを取り出す', () => {
        expect(parseBearerToken('Bearer abc.def')).toBe('abc.def')
        expect(parseBearerToken('Basic abc')).toBeNull()
        expect(parseBearerToken(null)).toBeNull()
    })
})

describe('validateAuthorizeParams', () => {
    const base = {
        responseType: 'code',
        clientId: 'c',
        redirectUri: 'https://claude.ai/api/mcp/auth_callback',
        codeChallenge: 'x',
        codeChallengeMethod: 'S256',
    }
    const resource = 'https://app.example.com/api/mcp'

    it('正しいリクエストは通す', () => {
        expect(validateAuthorizeParams({ ...base, resource }, resource)).toBeNull()
        expect(validateAuthorizeParams(base, resource)).toBeNull()
    })

    it('PKCE なし・plain は拒否する', () => {
        expect(validateAuthorizeParams({ ...base, codeChallenge: '' }, resource)?.error).toBe('invalid_request')
        expect(validateAuthorizeParams({ ...base, codeChallengeMethod: 'plain' }, resource)?.error).toBe('invalid_request')
    })

    it('別の resource は拒否する', () => {
        expect(validateAuthorizeParams({ ...base, resource: 'https://other/api/mcp' }, resource)?.error).toBe('invalid_target')
    })
})

describe('buildRedirectUrl', () => {
    it('既存のクエリを残して追加する', () => {
        expect(buildRedirectUrl('http://localhost:1/cb?a=1', { code: 'x', state: undefined }))
            .toBe('http://localhost:1/cb?a=1&code=x')
    })
})
