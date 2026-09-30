import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { getAppBaseUrl } from '@/lib/app-url'
import { GOOGLE_STATE_COOKIE, buildGoogleAuthUrl, googleRedirectUri, isGoogleConfigured } from '@/lib/google/oauth'

export const dynamic = 'force-dynamic'

/**
 * Googleカレンダーとの連携を始める（Google の許可画面へ移動）
 * GET /api/google/connect?channelId=...
 */
export async function GET(request: NextRequest) {
    const back = (params: string) => NextResponse.redirect(new URL(`/dashboard/booking?${params}`, getAppBaseUrl(request.headers)))

    const user = await getSessionUser()
    if (!user) return NextResponse.redirect(new URL('/login', getAppBaseUrl(request.headers)))

    const channelId = request.nextUrl.searchParams.get('channelId') ?? ''
    if (!(await isChannelMember(user.id, channelId))) return back('google=forbidden')
    if (!isGoogleConfigured()) return back('google=not_configured')

    const state = crypto.randomBytes(24).toString('base64url')
    const response = NextResponse.redirect(buildGoogleAuthUrl({
        clientId: process.env.GOOGLE_CLIENT_ID!,
        redirectUri: googleRedirectUri(getAppBaseUrl(request.headers)),
        state,
    }))
    response.cookies.set(GOOGLE_STATE_COOKIE, JSON.stringify({ state, channelId }), {
        httpOnly: true,
        secure: request.nextUrl.protocol === 'https:',
        sameSite: 'lax',
        path: '/api/google',
        maxAge: 600,
    })
    return response
}
