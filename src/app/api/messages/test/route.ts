import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
    LineClient,
    LineContentError,
    buildLineMessages,
    replaceNamePlaceholder,
    toErrorMessage,
} from '@/lib/line'

/**
 * テスト送信
 * POST /api/messages/test
 *
 * 本番の一斉配信と同じ変換（buildLineMessages）を使う。
 * ここで通れば本番でもLINEに弾かれない、という状態にしておくためのエンドポイント。
 *
 * 注: アクションのうちタグ付与・ステップ配信・自動返信はpostbackで動くため、
 * 保存前のテスト送信ではタップしても反応しない（mid=TEST_SEND のダミーを送る）。
 * URL遷移はテスト送信でもそのまま動作する。
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const { channelId, userId, content } = await request.json()

        if (!channelId || !userId || !content) {
            return NextResponse.json({ error: '必要なパラメータが不足しています' }, { status: 400 })
        }

        // チャンネル情報の取得
        const { data: channel, error: channelError } = await supabase
            .from('channels')
            .select('channel_access_token')
            .eq('id', channelId)
            .single()

        if (channelError || !channel) {
            return NextResponse.json({ error: 'チャンネルが見つかりません' }, { status: 404 })
        }

        const lineClient = new LineClient(channel.channel_access_token)

        let lineMessages: object[]
        try {
            lineMessages = buildLineMessages(content, {
                postbackData: 'action=custom&mid=TEST_SEND',
            })
        } catch (err) {
            if (err instanceof LineContentError) {
                return NextResponse.json({ error: err.message }, { status: 400 })
            }
            throw err
        }

        // テスト送信先のユーザー情報を取得（名前置換用）
        const { data: testUser } = await supabase
            .from('line_users')
            .select('display_name')
            .eq('channel_id', channelId)
            .eq('line_user_id', userId)
            .single()

        await lineClient.pushMessage(
            userId,
            replaceNamePlaceholder(lineMessages, testUser?.display_name)
        )

        return NextResponse.json({ success: true })

    } catch (error) {
        console.error('テスト送信エラー:', error)
        // LINEが返したエラー本文をそのまま返す（原因が分からないと直しようがないため）
        return NextResponse.json(
            { error: `メッセージ送信に失敗しました: ${toErrorMessage(error, 500)}` },
            { status: 500 }
        )
    }
}
