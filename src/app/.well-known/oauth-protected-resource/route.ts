import { NextRequest, NextResponse } from 'next/server'
import { buildProtectedResourceMetadata, getBaseUrl } from '@/lib/mcp/oauth'

/**
 * OAuth protected resource metadata（RFC 9728）
 * GET /.well-known/oauth-protected-resource
 *
 * Claude はここを読んで、/api/mcp のトークンをどこで発行してもらうかを知る。
 * /api/mcp の 401 はパス付きの /.well-known/oauth-protected-resource/api/mcp を指すが、
 * パスなしで探すクライアントもあるため両方で同じ内容を返す。
 */
export function GET(request: NextRequest) {
    return NextResponse.json(buildProtectedResourceMetadata(getBaseUrl(request.headers)), {
        headers: { 'Access-Control-Allow-Origin': '*' },
    })
}
