import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { createAdminClient } from '@/lib/supabase/server'
import { getAppBaseUrl } from '@/lib/app-url'
import { googleRedirectUri, isGoogleConfigured } from '@/lib/google/oauth'
import { getConnection } from '@/lib/google/calendar'

export const dynamic = 'force-dynamic'

/**
 * Googleカレンダー連携の状態（トークンは返さない）
 * GET /api/google/status?channelId=...
 */
export async function GET(request: NextRequest) {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
    const channelId = request.nextUrl.searchParams.get('channelId') ?? ''
    if (!(await isChannelMember(user.id, channelId))) return NextResponse.json({ error: '権限がありません' }, { status: 403 })

    const connection = await getConnection(createAdminClient(), channelId).catch(() => null)
    return NextResponse.json({
        configured: isGoogleConfigured(),
        redirectUri: googleRedirectUri(getAppBaseUrl(request.headers)),
        connected: Boolean(connection),
        email: connection?.google_email ?? null,
        calendarId: connection?.calendar_id ?? null,
        lastSyncedAt: connection?.last_synced_at ?? null,
        lastError: connection?.last_error ?? null,
    })
}
