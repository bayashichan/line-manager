/**
 * AIエージェント連携（MCP）の OAuth で使う DB 操作。
 *
 * テーブルは supabase/migrations/20260929000000_add_mcp_oauth.sql。
 * RLS でブラウザからは読めないようにしてあるので、必ずサービスロール（createAdminClient）で触る。
 * トークン・コード・シークレットは平文を保存せず、SHA-256 のハッシュで引く。
 */

import { createAdminClient } from '@/lib/supabase/server'
import {
    ACCESS_TOKEN_TTL_SECONDS,
    AUTH_CODE_TTL_SECONDS,
    REFRESH_TOKEN_TTL_SECONDS,
    randomToken,
    sha256Hex,
    timingSafeEqualString,
    type TokenEndpointAuthMethod,
} from './oauth'

type AdminClient = ReturnType<typeof createAdminClient>

export type OAuthClient = {
    client_id: string
    client_secret_hash: string | null
    client_name: string | null
    redirect_uris: string[]
    token_endpoint_auth_method: TokenEndpointAuthMethod
}

export type IssuedTokens = {
    access_token: string
    token_type: 'Bearer'
    expires_in: number
    refresh_token: string
    scope?: string
}

export async function registerClient(
    supabase: AdminClient,
    input: { clientName: string | null; redirectUris: string[]; authMethod: TokenEndpointAuthMethod }
): Promise<{ clientId: string; clientSecret: string | null; createdAt: Date }> {
    const clientId = `mcp_${randomToken(18)}`
    const clientSecret = input.authMethod === 'none' ? null : randomToken(32)

    const { data, error } = await supabase
        .from('mcp_oauth_clients')
        .insert({
            client_id: clientId,
            client_secret_hash: clientSecret ? sha256Hex(clientSecret) : null,
            client_name: input.clientName,
            redirect_uris: input.redirectUris,
            token_endpoint_auth_method: input.authMethod,
        })
        .select('created_at')
        .single()

    if (error || !data) {
        throw new Error(`クライアント登録に失敗しました: ${error?.message ?? 'unknown'}`)
    }

    return { clientId, clientSecret, createdAt: new Date(data.created_at) }
}

export async function getClient(supabase: AdminClient, clientId: string): Promise<OAuthClient | null> {
    if (!clientId) return null
    const { data } = await supabase
        .from('mcp_oauth_clients')
        .select('client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method')
        .eq('client_id', clientId)
        .maybeSingle()
    return (data as OAuthClient | null) ?? null
}

/** トークンエンドポイントでのクライアント認証。公開クライアントはシークレット不要 */
export function authenticateClient(client: OAuthClient, clientSecret: string | undefined): boolean {
    if (client.token_endpoint_auth_method === 'none') return true
    if (!clientSecret || !client.client_secret_hash) return false
    return timingSafeEqualString(sha256Hex(clientSecret), client.client_secret_hash)
}

export async function createAuthorizationCode(
    supabase: AdminClient,
    input: {
        clientId: string
        userId: string
        redirectUri: string
        codeChallenge: string
        scope?: string
        resource?: string
    }
): Promise<string> {
    const code = randomToken(32)
    const { error } = await supabase.from('mcp_oauth_codes').insert({
        code_hash: sha256Hex(code),
        client_id: input.clientId,
        user_id: input.userId,
        redirect_uri: input.redirectUri,
        code_challenge: input.codeChallenge,
        scope: input.scope ?? null,
        resource: input.resource ?? null,
        expires_at: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000).toISOString(),
    })
    if (error) {
        throw new Error(`認可コードの保存に失敗しました: ${error.message}`)
    }
    return code
}

export type StoredAuthCode = {
    client_id: string
    user_id: string
    redirect_uri: string
    code_challenge: string
    scope: string | null
    resource: string | null
    expires_at: string
}

/**
 * 認可コードを取り出して即座に消す（1回限り）。
 * delete ... returning の1回で行うので、同じコードを2回使われても2回目は null になる。
 */
export async function consumeAuthorizationCode(supabase: AdminClient, code: string): Promise<StoredAuthCode | null> {
    const { data } = await supabase
        .from('mcp_oauth_codes')
        .delete()
        .eq('code_hash', sha256Hex(code))
        .select('client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at')
        .maybeSingle()

    if (!data) return null
    if (new Date(data.expires_at).getTime() <= Date.now()) return null
    return data as StoredAuthCode
}

export async function issueTokens(
    supabase: AdminClient,
    input: { clientId: string; userId: string; scope?: string | null }
): Promise<IssuedTokens> {
    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    const now = Date.now()

    const { error } = await supabase.from('mcp_oauth_tokens').insert({
        access_token_hash: sha256Hex(accessToken),
        refresh_token_hash: sha256Hex(refreshToken),
        client_id: input.clientId,
        user_id: input.userId,
        scope: input.scope ?? null,
        access_expires_at: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
        refresh_expires_at: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    })
    if (error) {
        throw new Error(`トークンの保存に失敗しました: ${error.message}`)
    }

    return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refreshToken,
        ...(input.scope ? { scope: input.scope } : {}),
    }
}

/**
 * リフレッシュトークンを使って新しいトークンを発行する。
 * 公開クライアントでは使い回しを防ぐため、古いトークンは必ず無効化して入れ替える（ローテーション）。
 */
export async function rotateRefreshToken(
    supabase: AdminClient,
    refreshToken: string,
    clientId: string
): Promise<IssuedTokens | null> {
    const { data } = await supabase
        .from('mcp_oauth_tokens')
        .delete()
        .eq('refresh_token_hash', sha256Hex(refreshToken))
        .select('client_id, user_id, scope, refresh_expires_at')
        .maybeSingle()

    if (!data) return null
    if (data.client_id !== clientId) return null
    if (new Date(data.refresh_expires_at).getTime() <= Date.now()) return null

    return issueTokens(supabase, { clientId, userId: data.user_id, scope: data.scope })
}

/** /api/mcp に付いてきたアクセストークンを検証し、利用者のIDを返す */
export async function verifyAccessToken(
    supabase: AdminClient,
    accessToken: string
): Promise<{ userId: string; clientId: string; scope: string | null } | null> {
    const { data } = await supabase
        .from('mcp_oauth_tokens')
        .select('user_id, client_id, scope, access_expires_at')
        .eq('access_token_hash', sha256Hex(accessToken))
        .maybeSingle()

    if (!data) return null
    if (new Date(data.access_expires_at).getTime() <= Date.now()) return null
    return { userId: data.user_id, clientId: data.client_id, scope: data.scope }
}
