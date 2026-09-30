import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { isAllowedRedirectUri, SUPPORTED_AUTH_METHODS, type TokenEndpointAuthMethod } from '@/lib/mcp/oauth'
import { registerClient } from '@/lib/mcp/oauth-store'

/**
 * 動的クライアント登録（RFC 7591）
 * POST /api/oauth/register
 *
 * Claude がコネクタを追加したときに自分自身をクライアントとして登録しに来る。
 * 誰でも呼べるエンドポイントなので、戻り先は Claude / ループバック / 明示許可のURLに限る
 * （src/lib/mcp/oauth.ts の isAllowedRedirectUri）。
 */
export async function POST(request: NextRequest) {
    let body: Record<string, unknown>
    try {
        body = await request.json()
    } catch {
        return registrationError('invalid_client_metadata', 'JSON を送ってください')
    }

    const redirectUris = body.redirect_uris
    if (
        !Array.isArray(redirectUris) ||
        redirectUris.length === 0 ||
        redirectUris.length > 10 ||
        !redirectUris.every((uri): uri is string => typeof uri === 'string' && uri.length <= 2000)
    ) {
        return registrationError('invalid_redirect_uri', 'redirect_uris を1件以上指定してください')
    }

    const disallowed = redirectUris.filter(uri => !isAllowedRedirectUri(uri))
    if (disallowed.length > 0) {
        return registrationError(
            'invalid_redirect_uri',
            `許可されていない戻り先です: ${disallowed.join(', ')}`
        )
    }

    // RFC 7591 では省略時 client_secret_basic。Claude は公開クライアント（none）で登録してくる
    const requestedMethod = body.token_endpoint_auth_method ?? 'client_secret_basic'
    if (!SUPPORTED_AUTH_METHODS.includes(requestedMethod as TokenEndpointAuthMethod)) {
        return registrationError('invalid_client_metadata', `token_endpoint_auth_method は ${SUPPORTED_AUTH_METHODS.join(' / ')} のいずれかです`)
    }
    const authMethod = requestedMethod as TokenEndpointAuthMethod

    const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token']
    if (!grantTypes.every(g => g === 'authorization_code' || g === 'refresh_token')) {
        return registrationError('invalid_client_metadata', 'grant_types は authorization_code / refresh_token のみ対応しています')
    }

    const responseTypes = Array.isArray(body.response_types) ? body.response_types : ['code']
    if (!responseTypes.every(r => r === 'code')) {
        return registrationError('invalid_client_metadata', 'response_types は code のみ対応しています')
    }

    const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : null

    try {
        const supabase = createAdminClient()
        const { clientId, clientSecret, createdAt } = await registerClient(supabase, {
            clientName,
            redirectUris,
            authMethod,
        })

        return NextResponse.json(
            {
                client_id: clientId,
                client_id_issued_at: Math.floor(createdAt.getTime() / 1000),
                ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
                client_name: clientName ?? undefined,
                redirect_uris: redirectUris,
                token_endpoint_auth_method: authMethod,
                grant_types: grantTypes,
                response_types: responseTypes,
            },
            { status: 201, headers: { 'Cache-Control': 'no-store' } }
        )
    } catch (error) {
        console.error('MCP クライアント登録エラー:', error)
        return NextResponse.json({ error: 'server_error' }, { status: 500 })
    }
}

function registrationError(error: string, description: string) {
    return NextResponse.json({ error, error_description: description }, { status: 400 })
}
