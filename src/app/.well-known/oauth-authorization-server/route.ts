import { NextRequest, NextResponse } from 'next/server'
import { buildAuthorizationServerMetadata, getBaseUrl } from '@/lib/mcp/oauth'

/**
 * OAuth authorization server metadata（RFC 8414）
 * GET /.well-known/oauth-authorization-server
 */
export function GET(request: NextRequest) {
    return NextResponse.json(buildAuthorizationServerMetadata(getBaseUrl(request.headers)), {
        headers: { 'Access-Control-Allow-Origin': '*' },
    })
}
