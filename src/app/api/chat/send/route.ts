import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'

/**
 * メッセージ送信API
 * POST /api/chat/send
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const { channelId, lineUserId, text, originalContentUrl, previewImageUrl, type } = body

        if (!channelId || !lineUserId) {
            return NextResponse.json(
                { error: 'チャンネルIDまたはユーザーIDが不足しています' },
                { status: 400 }
            )
        }

        if (type === 'text' && !text) {
            return NextResponse.json(
                { error: 'メッセージテキストが不足しています' },
                { status: 400 }
            )
        }

        if ((type === 'image' || type === 'video') && (!originalContentUrl || !previewImageUrl)) {
            return NextResponse.json(
                { error: '画像または動画のURLが不足しています' },
                { status: 400 }
            )
        }

        const supabase = await createClient()

        // 1. 権限チェック (送信者がそのチャンネルのメンバーか)
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: '認証エラー' }, { status: 401 })

        // チャンネル情報を取得 (LINE送信用)
        // ※セキュリティのため、adminクライアントではなく、RLSの効く通常クライアントでチェックしてから、
        //   必要ならadminクライアントでSecretを取得する。
        //   今回はchannelsテーブルはメンバーなら参照可なので通常クライアントでOKだが、
        //   Secret/TokenはRLSで隠されている場合があるため確認が必要。
        //   現在のschemaではchannelsは全カラム参照可能なのでOK。
        const { data: channel, error: chError } = await supabase
            .from('channels')
            .select('*')
            .eq('id', channelId)
            .single()

        if (chError || !channel) {
            return NextResponse.json({ error: 'チャンネルが見つかりません' }, { status: 404 })
        }

        // 2. LINEに送信
        const lineClient = new LineClient(channel.channel_access_token)

        // ユーザーのLINE ID (UUIDではなく実際のLINE ID) を取得
        // chat_messagesにはUUIDを使うが、LINE送信にはLINE IDが必要
        const { data: lineUser, error: luError } = await supabase
            .from('line_users')
            .select('line_user_id') // 実際のLINE ID
            .eq('id', lineUserId) // 内部UUID
            .single()

        if (luError || !lineUser) {
            return NextResponse.json({ error: 'ユーザーが見つかりません' }, { status: 404 })
        }

        // 送信メッセージの構築
        const messages: any[] = []

        if (body.type === 'image') {
            messages.push({
                type: 'image',
                originalContentUrl: body.originalContentUrl,
                previewImageUrl: body.previewImageUrl || body.originalContentUrl
            })
        } else if (body.type === 'video') {
            messages.push({
                type: 'video',
                originalContentUrl: body.originalContentUrl,
                previewImageUrl: body.previewImageUrl
            })
        } else {
            // Default to text
            messages.push({ type: 'text', text: text })
        }

        try {
            await lineClient.pushMessage(lineUser.line_user_id, messages)
        } catch (lineError) {
            console.error('LINE送信エラー:', lineError)
            return NextResponse.json({ error: 'LINEへの送信に失敗しました' }, { status: 500 })
        }

        // 3. DBに保存
        const content = body.type === 'image' || body.type === 'video'
            ? {
                type: body.type,
                originalContentUrl: body.originalContentUrl,
                previewImageUrl: body.previewImageUrl
            }
            : { type: 'text', text: text }

        const { error: dbError } = await supabase
            .from('chat_messages')
            .insert({
                channel_id: channelId,
                line_user_id: lineUserId, // 内部UUID
                sender: 'admin',
                content_type: body.type || 'text',
                content: content,
                read_at: null, // 管理者メッセージは未読状態で開始
            })

        if (dbError) {
            console.error('DB保存エラー:', dbError)
            // LINE送信は成功しているので、エラーとしては返さないがログには残す
        }

        // メッセージ内容のテキスト化
        const messageText = body.type === 'text' ? text :
            body.type === 'image' ? '画像を送信しました' :
                body.type === 'video' ? '動画を送信しました' :
                    'メッセージを送信しました'

        // ユーザー情報の最終メッセージ日時を更新
        await supabase
            .from('line_users')
            .update({
                last_message_at: new Date().toISOString(),
                last_message_content: messageText
            })
            .eq('id', lineUserId)

        return NextResponse.json({ success: true })

    } catch (error) {
        console.error('チャット送信エラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
