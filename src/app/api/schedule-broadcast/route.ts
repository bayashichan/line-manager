import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { Client } from '@upstash/qstash'

/**
 * 予約配信のスケジュール
 * POST /api/schedule-broadcast
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const { messageId, scheduledAt } = await request.json()

        if (!messageId || !scheduledAt) {
            return NextResponse.json({ error: 'messageId と scheduledAt が必要です' }, { status: 400 })
        }

        // 予約日時の検証 (過去の日時はエラー)
        const scheduledTime = new Date(scheduledAt).getTime()
        const now = Date.now()
        if (scheduledTime <= now) {
            return NextResponse.json({ error: '過去の日時は指定できません' }, { status: 400 })
        }

        // {name} QStash クライアント初期化
        const qstashToken = process.env.QSTASH_TOKEN
        if (!qstashToken) {
            console.error('QSTASH_TOKEN is not configured')
            return NextResponse.json({ error: 'サーバー設定エラー' }, { status: 500 })
        }

        const qstashClient = new Client({ token: qstashToken })

        // 送信先Webhook URLの組み立て
        // req.url からオリジンを取得 (例: https://example.com/api/schedule-broadcast -> https://example.com)
        const baseUrl = new URL(request.url).origin
        const destinationUrl = `${baseUrl}/api/webhook/qstash-line`

        // QStashにスケジュールジョブを登録
        const res = await qstashClient.publishJSON({
            url: destinationUrl,
            body: { messageId },
            notBefore: Math.floor(scheduledTime / 1000), // UNIXタイムスタンプ(秒)
            retries: 3, // 失敗時のリトライ回数
        })

        if (!res.messageId) {
            throw new Error('QStash へのジョブ登録に失敗しました')
        }

        // 予約ジョブIDをデータベースに保存
        const { error: updateError } = await supabase
            .from('messages')
            .update({ qstash_message_id: res.messageId })
            .eq('id', messageId)

        if (updateError) {
            console.error('QStash ID 保存エラー:', updateError)
            // 致命的なエラーにはしないが記録しておく
        }

        return NextResponse.json({ success: true, qstashMessageId: res.messageId })
    } catch (error: any) {
        console.error('予約設定エラー:', error)
        return NextResponse.json(
            { error: error?.message || '予約設定に失敗しました' },
            { status: 500 }
        )
    }
}
