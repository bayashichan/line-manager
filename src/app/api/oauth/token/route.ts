import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getBaseUrl, mcpResourceUrl, parseBasicAuth, verifyPkceS256 } from '@/lib/mcp/oauth'
import {
    authenticateClient,
    consumeAuthorizationCode,
    getClient,
    issueTokens,
    rotateRefreshToken,
} from '@/lib/mcp/oauth-store'

/**
 * トークンエンドポイント
 * POST /api/oauth/token
 *
 * - authorization_code: 認可コード + PKCE の code_verifier をアクセストークンに交換
 * - refresh_token:      リフレッシュトークンを新しいトークンに交換（古い方は無効化）
 *
 * Claude は application/x-www-form-urlencoded で送ってくる（RFC 6749）。
 */
export async function POST(request: NextRequest) {
    const params = await readBody(request)
    if (!params) {
        return tokenError('invalid_request', 'リクエストの形式が不正です')
    }

    // クライアント認証: Basic ヘッダー or ボディの client_id / client_secret
    const basic = parseBasicAuth(request.headers.get('authorization'))
    const clientId = basic?.clientId ?? params.get('client_id') ?? ''
    const clientSecret = basic?.clientSecret ?? params.get('client_secret') ?? undefined

    const supabase = createAdminClient()
    const client = await getClient(supabase, clientId)
    if (!client || !authenticateClient(client, clientSecret)) {
        return tokenError('invalid_client', 'クライアント認証に失敗しました', 401)
    }

    const grantType = params.get('grant_type')

    try {
        if (grantType === 'authorization_code') {
            const code = params.get('code')
            const codeVerifier = params.get('code_verifier')
            const redirectUri = params.get('redirect_uri')
            if (!code || !codeVerifier) {
                return tokenError('invalid_request', 'code と code_verifier が必要です')
            }

            const stored = await consumeAuthorizationCode(supabase, code)
            if (
                !stored ||
                stored.client_id !== client.client_id ||
                stored.redirect_uri !== redirectUri ||
                !verifyPkceS256(codeVerifier, stored.code_challenge)
            ) {
                return tokenError('invalid_grant', '認可コードが無効か期限切れです')
            }

            const resource = params.get('resource')
            if (resource && resource !== mcpResourceUrl(getBaseUrl(request.headers))) {
                return tokenError('invalid_target', 'resource が一致しません')
            }

            const tokens = await issueTokens(supabase, {
                clientId: client.client_id,
                userId: stored.user_id,
                scope: stored.scope,
            })
            return tokenResponse(tokens)
        }

        if (grantType === 'refresh_token') {
            const refreshToken = params.get('refresh_token')
            if (!refreshToken) {
                return tokenError('invalid_request', 'refresh_token が必要です')
            }
            const tokens = await rotateRefreshToken(supabase, refreshToken, client.client_id)
            if (!tokens) {
                return tokenError('invalid_grant', 'リフレッシュトークンが無効か期限切れです')
            }
            return tokenResponse(tokens)
        }

        return tokenError('unsupported_grant_type', 'authorization_code / refresh_token のみ対応しています')
    } catch (error) {
        console.error('MCP トークン発行エラー:', error)
        return NextResponse.json({ error: 'server_error' }, { status: 500, headers: noStore })
    }
}

const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }

async function readBody(request: NextRequest): Promise<URLSearchParams | null> {
    const contentType = request.headers.get('content-type') ?? ''
    try {
        if (contentType.includes('application/json')) {
            const json = await request.json()
            const params = new URLSearchParams()
            for (const [key, value] of Object.entries(json ?? {})) {
                if (typeof value === 'string') params.set(key, value)
            }
            return params
        }
        return new URLSearchParams(await request.text())
    } catch {
        return null
    }
}

function tokenResponse(tokens: object) {
    return NextResponse.json(tokens, { headers: noStore })
}

function tokenError(error: string, description: string, status = 400) {
    return NextResponse.json({ error, error_description: description }, { status, headers: noStore })
}
