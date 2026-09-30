/**
 * AIエージェント連携（MCP）の OAuth 2.1 で使う純粋なヘルパー。
 *
 * DBに触れる処理は ./oauth-store.ts に分けてある。ここはテストしやすいよう
 * 入力だけで結果が決まる関数に限定する。
 *
 * Claude 側の要件（https://claude.com/docs/connectors/building/authentication）:
 * - PKCE は S256 のみ
 * - 戻り先は claude.ai / claude.com の固定URLと、Claude Code のループバック（ポート可変）
 * - トークンエンドポイントは application/x-www-form-urlencoded を受け付ける
 * - 無効なリフレッシュトークンには invalid_grant を返す
 */

import crypto from 'crypto'

/** アクセストークンの有効期間（秒）。Claude は期限の少し前に自動で更新する */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
/** リフレッシュトークンの有効期間（秒）。更新のたびに新しいトークンへ入れ替える */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
/** 認可コードの有効期間（秒） */
export const AUTH_CODE_TTL_SECONDS = 10 * 60

/** MCP エンドポイントのパス。protected resource metadata の resource と一致させる */
export const MCP_PATH = '/api/mcp'

/**
 * Claude のホスト型アプリ（Web / デスクトップ / モバイル / Cowork）の戻り先。
 * これ以外の https の戻り先は MCP_ALLOWED_REDIRECT_URIS で明示的に許可したものだけ受け付ける。
 */
export const CLAUDE_REDIRECT_URIS = [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
]

export type TokenEndpointAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic'

export const SUPPORTED_AUTH_METHODS: TokenEndpointAuthMethod[] = [
    'none',
    'client_secret_post',
    'client_secret_basic',
]

/** 推測できない長さのランダム文字列（トークン・コード・クライアントID用） */
export function randomToken(bytes = 32): string {
    return crypto.randomBytes(bytes).toString('base64url')
}

/** DB に保存するときはハッシュだけにする */
export function sha256Hex(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex')
}

/** 長さの違いで早期に抜けないよう、ハッシュ同士を一定時間で比較する */
export function timingSafeEqualString(a: string, b: string): boolean {
    const ha = crypto.createHash('sha256').update(a).digest()
    const hb = crypto.createHash('sha256').update(b).digest()
    return crypto.timingSafeEqual(ha, hb)
}

/**
 * PKCE（S256）の検証。
 * code_challenge = BASE64URL(SHA256(code_verifier))
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
    // RFC 7636: verifier は 43〜128 文字の unreserved 文字
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false
    const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    return timingSafeEqualString(computed, codeChallenge)
}

function isLoopbackHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function parseUrl(value: string): URL | null {
    try {
        return new URL(value)
    } catch {
        return null
    }
}

/** 環境変数で追加許可した戻り先（カンマ区切り） */
export function extraAllowedRedirectUris(env: string | undefined = process.env.MCP_ALLOWED_REDIRECT_URIS): string[] {
    if (!env) return []
    return env.split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * 動的クライアント登録で受け付ける戻り先か。
 *
 * 誰でもクライアント登録できる仕組みなので、戻り先を絞らないと
 * 「同意画面を悪用して他人のコードを自分のサーバーへ送らせる」フィッシングに使われうる。
 * そのため Claude の戻り先・ループバック・明示的に許可したURLだけを受け付ける。
 */
export function isAllowedRedirectUri(uri: string, extra: string[] = extraAllowedRedirectUris()): boolean {
    const url = parseUrl(uri)
    if (!url) return false
    if (url.hash) return false

    if (CLAUDE_REDIRECT_URIS.includes(uri) || extra.includes(uri)) return true

    // Claude Code などのネイティブクライアントは http のループバックに戻す（RFC 8252）
    return url.protocol === 'http:' && isLoopbackHost(url.hostname)
}

/**
 * 認可リクエストの redirect_uri が、登録済みの戻り先と一致するか。
 * ループバックはセッションごとにポートが変わるため、ポートだけは無視して比べる（RFC 8252 7.3）。
 */
export function redirectUriMatches(registered: string[], requested: string): boolean {
    if (registered.includes(requested)) return true

    const req = parseUrl(requested)
    if (!req || req.protocol !== 'http:' || !isLoopbackHost(req.hostname)) return false

    return registered.some(candidate => {
        const reg = parseUrl(candidate)
        if (!reg || reg.protocol !== 'http:' || !isLoopbackHost(reg.hostname)) return false
        return (
            reg.hostname === req.hostname &&
            reg.pathname === req.pathname &&
            reg.search === req.search
        )
    })
}

/** 戻り先URLにクエリを付け足す（既存のクエリは残す） */
export function buildRedirectUrl(redirectUri: string, params: Record<string, string | undefined>): string {
    const url = new URL(redirectUri)
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, value)
    }
    return url.toString()
}

/**
 * このサーバー自身の URL（例: https://line-manager.example.com）。
 *
 * Claude には利用者が入力した URL と protected resource metadata の resource を
 * 完全一致させる必要があるため、リクエストが来たホストから組み立てる。
 * 独自ドメインを使うなどで固定したい場合は MCP_BASE_URL で上書きできる。
 */
export function getBaseUrl(
    headers: Pick<Headers, 'get'>,
    override: string | undefined = process.env.MCP_BASE_URL
): string {
    if (override) return override.replace(/\/+$/, '')

    const host = headers.get('x-forwarded-host')?.split(',')[0]?.trim() || headers.get('host') || 'localhost:3000'
    const forwardedProto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    const proto = forwardedProto || (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
    return `${proto}://${host}`
}

export function mcpResourceUrl(baseUrl: string): string {
    return `${baseUrl}${MCP_PATH}`
}

export function protectedResourceMetadataUrl(baseUrl: string): string {
    return `${baseUrl}/.well-known/oauth-protected-resource${MCP_PATH}`
}

/** RFC 9728: protected resource metadata */
export function buildProtectedResourceMetadata(baseUrl: string) {
    return {
        resource: mcpResourceUrl(baseUrl),
        authorization_servers: [baseUrl],
        bearer_methods_supported: ['header'],
        resource_name: 'LINE Manager',
    }
}

/** RFC 8414: authorization server metadata */
export function buildAuthorizationServerMetadata(baseUrl: string) {
    return {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/api/oauth/token`,
        registration_endpoint: `${baseUrl}/api/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: SUPPORTED_AUTH_METHODS,
    }
}

/**
 * Authorization: Basic ヘッダーからクライアント認証情報を取り出す（RFC 6749 2.3.1）。
 * ID とシークレットはそれぞれ form-urlencoded された上で Base64 化されている。
 */
export function parseBasicAuth(header: string | null): { clientId: string; clientSecret: string } | null {
    if (!header || !header.toLowerCase().startsWith('basic ')) return null
    try {
        const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
        const sep = decoded.indexOf(':')
        if (sep < 0) return null
        return {
            clientId: decodeURIComponent(decoded.slice(0, sep).replace(/\+/g, ' ')),
            clientSecret: decodeURIComponent(decoded.slice(sep + 1).replace(/\+/g, ' ')),
        }
    } catch {
        return null
    }
}

/** Authorization: Bearer ヘッダーからトークンを取り出す */
export function parseBearerToken(header: string | null): string | null {
    if (!header) return null
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    return match ? match[1].trim() : null
}

export type AuthorizeParams = {
    responseType: string
    clientId: string
    redirectUri: string
    state?: string
    codeChallenge: string
    codeChallengeMethod: string
    scope?: string
    resource?: string
}

/** ページの searchParams / フォームの値から認可リクエストを取り出す */
export function readAuthorizeParams(get: (key: string) => string | undefined): AuthorizeParams {
    return {
        responseType: get('response_type') ?? '',
        clientId: get('client_id') ?? '',
        redirectUri: get('redirect_uri') ?? '',
        state: get('state') || undefined,
        codeChallenge: get('code_challenge') ?? '',
        codeChallengeMethod: get('code_challenge_method') ?? '',
        scope: get('scope') || undefined,
        resource: get('resource') || undefined,
    }
}

/**
 * 認可リクエストの中身（戻り先が確定したあとに見る部分）を検証する。
 * エラー時は OAuth のエラーコードを返し、呼び出し側が戻り先へリダイレクトする。
 */
export function validateAuthorizeParams(
    params: AuthorizeParams,
    expectedResource: string
): { error: string; description: string } | null {
    if (params.responseType !== 'code') {
        return { error: 'unsupported_response_type', description: 'response_type は code のみ対応しています' }
    }
    if (!params.codeChallenge || params.codeChallengeMethod !== 'S256') {
        return { error: 'invalid_request', description: 'PKCE（code_challenge_method=S256）が必要です' }
    }
    if (params.resource && params.resource !== expectedResource) {
        return { error: 'invalid_target', description: `resource は ${expectedResource} を指定してください` }
    }
    return null
}
