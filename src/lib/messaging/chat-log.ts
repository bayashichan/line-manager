/**
 * こちらから送ったメッセージを 1:1 チャットの履歴に残す。
 * 失敗しても送信自体は成功しているので、呼び出し元の処理は止めない。
 */

import type { createAdminClient } from '@/lib/supabase/server'

type AdminClient = ReturnType<typeof createAdminClient>

/** 一覧に出す短い要約（ステップ配信と同じ表記） */
export function summarizeMessages(messages: Record<string, unknown>[]): string {
    const first = messages[0]
    if (!first) return 'メッセージが送信されました'
    if (first.type === 'text' && typeof first.text === 'string') return first.text
    if (first.type === 'image') return '画像が送信されました'
    if (first.type === 'video') return '動画が送信されました'
    if (first.type === 'flex' || first.type === 'template') {
        return typeof first.altText === 'string' ? first.altText : 'リッチメッセージが送信されました'
    }
    return 'メッセージが送信されました'
}

export async function logOutgoingMessages(
    supabase: AdminClient,
    input: {
        channelId: string
        internalUserId: string
        messages: Record<string, unknown>[]
        /** プッシュなど、一覧の「最終メッセージ」も更新する場合 true */
        updateLastMessage?: boolean
    }
): Promise<void> {
    try {
        const rows = input.messages.map(message => ({
            channel_id: input.channelId,
            line_user_id: input.internalUserId,
            sender: 'admin',
            content_type: String(message.type),
            content: message,
        }))
        if (rows.length > 0) {
            const { error } = await supabase.from('chat_messages').insert(rows)
            if (error) console.error('チャット履歴の保存エラー:', error)
        }
        if (input.updateLastMessage) {
            await supabase
                .from('line_users')
                .update({
                    last_message_at: new Date().toISOString(),
                    last_message_content: summarizeMessages(input.messages),
                })
                .eq('id', input.internalUserId)
        }
    } catch (err) {
        console.error('チャット履歴の保存エラー:', err)
    }
}
