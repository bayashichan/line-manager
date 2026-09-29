import { updateSession } from '@/lib/supabase/middleware'
import { type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
    return await updateSession(request)
}

export const config = {
    matcher: [
        /*
         * 以下を除くすべてのリクエストパスにマッチ:
         * - _next/static (静的ファイル)
         * - _next/image (画像最適化)
         * - favicon.ico (ファビコン)
         * - 画像ファイル
         * - AIエージェント連携（MCP）のAPIとOAuthメタデータ
         *   （ブラウザのログインCookieではなくアクセストークンで認証するため、
         *    Supabaseセッションの確認は不要。Claude側の応答待ち時間も短く保つ）
         */
        '/((?!_next/static|_next/image|favicon.ico|api/mcp|api/oauth|\\.well-known|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
}
