import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { getAppBaseUrl } from '@/lib/app-url'
import { timingSafeEqualString } from '@/lib/mcp/oauth'
import { GOOGLE_STATE_COOKIE, emailFromIdToken, exchangeCode, googleRedirectUri, hasCalendarScopes, GoogleAuthError } from '@/lib/google/oauth'

export const dynamic = 'force-dynamic'

/**
 * Google の許可画面から戻ってくる先
 * GET /api/google/callback?code=...&state=...
 */
export async function GET(request: NextRequest) {
    const baseUrl = getAppBaseUrl(request.headers)
    const back = (params: string) => {
        const response = NextResponse.redirect(new URL(`/dashboard/booking?${params}`, baseUrl))
        response.cookies.delete({ name: GOOGLE_STATE_COOKIE, path: '/api/google' })
        return response
    }

    const params = request.nextUrl.searchParams
    if (params.get('error')) return back('google=denied')

    // 自分が始めた連携か（他サイトから送り込まれた code を受け付けない）
    let saved: { state?: string; channelId?: string } = {}
    try {
        saved = JSON.parse(request.cookies.get(GOOGLE_STATE_COOKIE)?.value ?? '{}')
    } catch {
        saved = {}
    }
    const state = params.get('state') ?? ''
    if (!saved.state || !saved.channelId || !timingSafeEqualString(saved.state, state)) return back('google=invalid_state')

    const user = await getSessionUser()
    if (!user || !(await isChannelMember(user.id, saved.channelId))) return back('google=forbidden')

    const code = params.get('code')
    if (!code) return back('google=error')

    try {
        const token = await exchangeCode({ code, redirectUri: googleRedirectUri(baseUrl) })
        if (!hasCalendarScopes(token.scope)) return back('google=missing_scope')
        if (!token.refresh_token) return back('google=no_refresh_token')

        const supabase = createAdminClient()
        const now = new Date()
        const { error } = await supabase.from('google_calendar_connections').upsert({
            channel_id: saved.channelId,
            google_email: emailFromIdToken(token.id_token),
            calendar_id: 'primary',
            refresh_token: token.refresh_token,
            access_token: token.access_token,
            access_token_expires_at: new Date(now.getTime() + token.expires_in * 1000).toISOString(),
            connected_by: user.id,
            last_error: null,
            updated_at: now.toISOString(),
        })
        if (error) {
            console.error('Google連携の保存エラー:', error)
            return back('google=error')
        }
        return back('google=connected')
    } catch (err) {
        console.error('Google連携エラー:', err)
        return back(err instanceof GoogleAuthError ? 'google=auth_failed' : 'google=error')
    }
}
