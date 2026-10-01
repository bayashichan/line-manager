import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { getAppBaseUrl } from '@/lib/app-url'
import {
    ScheduledChatError,
    createScheduledChatMessage,
    enqueueScheduledChatDelivery,
} from '@/lib/messaging/scheduled-chat'

/**
 * 1:1チャットの送信予約
 * POST /api/chat/schedule
 * Body: { channelId, lineUserId（line_users.id）, sendAt（ISO 8601）, messages: [{ type: 'text', text } | { type: 'image' | 'video', originalContentUrl, previewImageUrl }] }
 */
export async function POST(request: NextRequest) {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

    const { channelId, lineUserId, sendAt, messages } = await request.json().catch(() => ({}))
    if (!channelId || !lineUserId) {
        return NextResponse.json({ error: 'チャンネルIDまたはユーザーIDが不足しています' }, { status: 400 })
    }
    if (!(await isChannelMember(user.id, channelId))) {
        return NextResponse.json({ error: 'チャンネルが見つかりません' }, { status: 404 })
    }

    const supabase = createAdminClient()
    try {
        const result = await createScheduledChatMessage(supabase, {
            channelId,
            lineUserId,
            content: messages,
            sendAt,
            createdBy: user.id,
        })
        await enqueueScheduledChatDelivery(result.id, result.sendAt, getAppBaseUrl(request.headers))
        return NextResponse.json({ success: true, id: result.id, sendAt: result.sendAt.toISOString() })
    } catch (err) {
        if (err instanceof ScheduledChatError) {
            return NextResponse.json({ error: err.message }, { status: 400 })
        }
        console.error('チャットの送信予約エラー:', err)
        return NextResponse.json({ error: '予約に失敗しました' }, { status: 500 })
    }
}
