import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createAdminClient } from '@/lib/supabase/server'
import { getBaseUrl, parseBearerToken, protectedResourceMetadataUrl } from '@/lib/mcp/oauth'
import { verifyAccessToken } from '@/lib/mcp/oauth-store'
import { createMcpServer } from '@/lib/mcp/tools'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * AIエージェント連携（MCP）エンドポイント
 * POST /api/mcp
 *
 * Claude のコネクタにこのURLを登録すると、会話からステップ配信の作成などができる。
 * 認証は OAuth 2.1（/oauth/authorize で本人が許可 → /api/oauth/token でトークン発行）。
 * トークンがない・無効なときは 401 を返し、Claude に認可の手順を案内する（RFC 9728）。
 *
 * Vercel のサーバーレスで動かすため、セッションを持たない（stateless）モードで、
 * リクエストごとにサーバーを作って JSON で応答する。
 */
async function handle(request: Request): Promise<Response> {
    const baseUrl = getBaseUrl(request.headers)
    const token = parseBearerToken(request.headers.get('authorization'))
    const auth = token ? await verifyAccessToken(createAdminClient(), token) : null

    if (!token || !auth) {
        const params = [`resource_metadata="${protectedResourceMetadataUrl(baseUrl)}"`]
        if (token) params.push('error="invalid_token"')
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: {
                'Content-Type': 'application/json',
                'WWW-Authenticate': `Bearer ${params.join(', ')}`,
            },
        })
    }

    // セッションを持たないため、サーバーからの通知用ストリーム（GET）やセッション終了（DELETE）は使わない
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json', Allow: 'POST' },
        })
    }

    const server = createMcpServer({ userId: auth.userId, clientId: auth.clientId, baseUrl })
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    })
    await server.connect(transport)

    return transport.handleRequest(request, {
        authInfo: {
            token,
            clientId: auth.clientId,
            scopes: auth.scope ? auth.scope.split(' ') : [],
            extra: { userId: auth.userId },
        },
    })
}

export { handle as GET, handle as POST, handle as DELETE }
