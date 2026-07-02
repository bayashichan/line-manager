import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { Client } from '@upstash/qstash'

/**
 * 予約配信の再スケジュール（内容・配信日時の編集後にQStashジョブを登録し直す）
 * POST /api/messages/reschedule
 *
 * 既存のQStashジョブを削除し、新しい配信日時でジョブを登録し直す。
 * メッセージ本体（本文・タイトル・タグ・scheduled_at）の更新はクライアント側で
 * 事前に完了している前提で、ここではQStashジョブの張り替えのみを担当する。
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
        if (isNaN(scheduledTime) || scheduledTime <= now) {
            return NextResponse.json({ error: '過去の日時は指定できません' }, { status: 400 })
        }

        // メッセージと紐づくチャンネル権限を確認
        const { data: message, error: messageError } = await supabase
            .from('messages')
            .select(`
                id,
                status,
                qstash_message_id,
                channels!inner (
                    id,
                    channel_members!inner (profile_id)
                )
            `)
            .eq('id', messageId)
            .eq('channels.channel_members.profile_id', user.id)
            .single()

        if (messageError || !message) {
            return NextResponse.json({ error: 'メッセージが見つからないか、権限がありません' }, { status: 404 })
        }

        // 予約中のメッセージのみ編集可能
        if (message.status !== 'scheduled') {
            return NextResponse.json(
                { error: '予約中のメッセージのみ編集できます' },
                { status: 400 }
            )
        }

        // QStash クライアント初期化
        const qstashToken = process.env.QSTASH_TOKEN
        if (!qstashToken) {
            console.error('QSTASH_TOKEN is not configured')
            return NextResponse.json({ error: 'サーバー設定エラー' }, { status: 500 })
        }

        const qstashClient = new Client({ token: qstashToken })

        // 既存のQStashジョブを削除 (IDがある場合のみ)
        if (message.qstash_message_id) {
            try {
                await qstashClient.messages.delete(message.qstash_message_id)
            } catch (qstashError: any) {
                console.error('既存QStashジョブ削除エラー:', qstashError)
                // 既に見つからない場合でも新規登録は続行する
            }
        }

        // 送信先Webhook URLの組み立て
        const baseUrl = new URL(request.url).origin
        const destinationUrl = `${baseUrl}/api/webhook/qstash-line`

        // QStashに新しいスケジュールジョブを登録
        const res = await qstashClient.publishJSON({
            url: destinationUrl,
            body: { messageId },
            notBefore: Math.floor(scheduledTime / 1000), // UNIXタイムスタンプ(秒)
            retries: 3,
            headers: {
                authorization: `Bearer ${process.env.CRON_SECRET ?? ''}`,
            },
        })

        if (!res.messageId) {
            throw new Error('QStash へのジョブ登録に失敗しました')
        }

        // 新しい予約ジョブIDをデータベースに保存
        const { error: updateError } = await supabase
            .from('messages')
            .update({ qstash_message_id: res.messageId })
            .eq('id', messageId)

        if (updateError) {
            console.error('QStash ID 保存エラー:', updateError)
        }

        return NextResponse.json({ success: true, qstashMessageId: res.messageId })
    } catch (error: any) {
        console.error('再スケジュールエラー:', error)
        return NextResponse.json(
            { error: error?.message || '再スケジュールに失敗しました' },
            { status: 500 }
        )
    }
}
