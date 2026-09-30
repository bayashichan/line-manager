/**
 * Google の OAuth（担当者がこのツールに Googleカレンダーの利用を許可する）。
 *
 * 必要な環境変数: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET（Google Cloud で作る OAuth クライアント）
 * 戻り先: {このツールのURL}/api/google/callback（Google Cloud に登録しておく）
 *
 * 権限は必要最小限の2つだけ（L Harness と同じ）:
 * - calendar.events           予定の参照・作成・削除（予約の予定と Meet の作成）
 * - calendar.events.freebusy  予定がある時間帯の参照（空き枠の計算）
 * ほかに、連携したアカウントのメールアドレスを表示するため openid / email を求める。
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

export const CALENDAR_SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.events.freebusy',
]
const SCOPES = ['openid', 'email', ...CALENDAR_SCOPES]

export class GoogleAuthError extends Error {}

/** 連携の途中で使う Cookie（戻ってきたときに、自分が始めた連携か確かめる） */
export const GOOGLE_STATE_COOKIE = 'lm_google_oauth'

export function isGoogleConfigured(env: Record<string, string | undefined> = process.env): boolean {
    return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
}

export function googleRedirectUri(baseUrl: string): string {
    return `${baseUrl}/api/google/callback`
}

export function buildGoogleAuthUrl(input: { clientId: string; redirectUri: string; state: string }): string {
    const params = new URLSearchParams({
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        // リフレッシュトークンを毎回受け取るため
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state: input.state,
    })
    return `${AUTH_URL}?${params.toString()}`
}

export type GoogleTokenResponse = {
    access_token: string
    expires_in: number
    refresh_token?: string
    scope?: string
    id_token?: string
}

async function postToken(params: Record<string, string>): Promise<GoogleTokenResponse> {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
        const reason = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
        throw new GoogleAuthError(`Google の認証に失敗しました（${reason}）`)
    }
    return data as GoogleTokenResponse
}

export function exchangeCode(input: { code: string; redirectUri: string }): Promise<GoogleTokenResponse> {
    return postToken({
        code: input.code,
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
    })
}

export function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
    return postToken({
        refresh_token: refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        grant_type: 'refresh_token',
    })
}

export async function revokeToken(token: string): Promise<void> {
    await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
    }).catch(() => undefined)
}

/** 許可された権限に、カレンダーの2つが含まれているか（同意画面で外されることがある） */
export function hasCalendarScopes(scope: string | undefined): boolean {
    const granted = new Set((scope ?? '').split(/\s+/))
    return CALENDAR_SCOPES.every(s => granted.has(s))
}

/**
 * id_token からメールアドレスを取り出す。
 * トークンは Google のトークンエンドポイントから直接受け取ったものなので、署名の検証は省く。
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
    if (!idToken) return null
    try {
        const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'))
        return typeof payload.email === 'string' ? payload.email : null
    } catch {
        return null
    }
}
