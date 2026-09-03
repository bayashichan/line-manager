import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * みなし既読（inferred read）の実装。
 *
 * 【なぜ「みなし」なのか】
 * LINE Messaging API には既読を知る手段が一切ない。
 *   - 既読を通知するWebhookイベントが無い
 *   - 送信済みメッセージの既読状態を取得するAPIも無い
 * そのため「友だちがトークを開いた」と断定できる反応を根拠に既読を推定する。
 * 反応の時刻より前にこちらから送ったメッセージは、その画面に映っているはずなので既読とみなす。
 *
 * 推定の精度を落とさないための約束:
 *   - 根拠に使うのは友だち自身の操作だけ（配信やタグ付けなど管理側の操作では既読にしない）
 *   - 既読時刻は「反応が起きた時刻」を使う。処理時刻を使うとWebhookの遅延分ずれる
 *   - 一度付いた既読は上書きしない（read_at IS NULL の行だけ更新する）
 */

/** 既読と判断した根拠 */
export type ReadSource =
    /** 友だちがメッセージを送ってきた */
    | 'message'
    /** ボタン・リッチメニュー・カルーセルなどのタップ（postback） */
    | 'postback'
    /** 配信に含めたリンクのタップ */
    | 'link_click'
    /** その他の友だち起点のイベント */
    | 'other'

export type MarkReadParams = {
    channelId: string
    /** line_users.id（LINEのユーザーIDではなく内部UUID） */
    lineUserRowId: string
    /** 既読と見なす時刻（ISO8601）。省略時は現在時刻 */
    readAt?: string
    source: ReadSource
}

export type MarkReadResult = {
    /** 既読に変わった1:1チャットのメッセージ数 */
    chatMessages: number
    /** 既読に変わった配信対象行の数 */
    deliveries: number
}

/**
 * 指定時刻までに送った未読メッセージを既読にする。
 *
 * 失敗しても呼び出し元の主処理（メッセージ保存や自動応答）は止めないこと。
 * 既読はあくまで補助情報で、ここで例外を投げると本来届くべき処理が巻き添えになる。
 */
export async function markFriendReadUpTo(
    client: SupabaseClient,
    { channelId, lineUserRowId, readAt, source }: MarkReadParams
): Promise<MarkReadResult> {
    const readTime = readAt ?? new Date().toISOString()
    const result: MarkReadResult = { chatMessages: 0, deliveries: 0 }

    // 1. 1:1チャット上の管理者メッセージ（チャット送信・一斉配信・ステップ・自動応答すべて）
    const { data: chatRows, error: chatError } = await client
        .from('chat_messages')
        .update({ read_at: readTime, read_source: source })
        .eq('channel_id', channelId)
        .eq('line_user_id', lineUserRowId)
        .eq('sender', 'admin')
        .is('read_at', null)
        .lte('created_at', readTime)
        .select('id')

    if (chatError) {
        console.error('既読反映エラー(chat_messages):', chatError)
    } else {
        result.chatMessages = chatRows?.length ?? 0
    }

    // 2. 配信ごとの既読状況（配信履歴の「誰が読んだか」用）
    //    送信できていない行（failed/pending）は既読になりえないので status='sent' に限定する
    const { data: deliveryRows, error: deliveryError } = await client
        .from('message_recipients')
        .update({ read_at: readTime, read_source: source })
        .eq('line_user_id', lineUserRowId)
        .eq('status', 'sent')
        .is('read_at', null)
        .lte('sent_at', readTime)
        .select('id')

    if (deliveryError) {
        console.error('既読反映エラー(message_recipients):', deliveryError)
    } else {
        result.deliveries = deliveryRows?.length ?? 0
    }

    // 3. 友だち単位の基準時刻。既読判定の根拠として一覧表示にも使う
    const { error: userError } = await client
        .from('line_users')
        .update({ last_read_at: readTime })
        .eq('id', lineUserRowId)
        .or(`last_read_at.is.null,last_read_at.lt.${readTime}`)

    if (userError) {
        console.error('既読反映エラー(line_users):', userError)
    }

    return result
}

/**
 * LINEのユーザーIDから line_users.id（内部UUID）を引く。
 * 友だち行がまだ無い場合は null（初回follow時など）。
 */
export async function resolveLineUserRowId(
    client: SupabaseClient,
    channelId: string,
    lineUserId: string
): Promise<string | null> {
    const { data, error } = await client
        .from('line_users')
        .select('id')
        .eq('channel_id', channelId)
        .eq('line_user_id', lineUserId)
        .maybeSingle()

    if (error) {
        console.error('友だち取得エラー(既読処理):', error)
        return null
    }

    return data?.id ?? null
}

/**
 * Webhookイベントのtimestamp(ミリ秒)をISO文字列にする。
 * 値が無い・壊れている場合は現在時刻にフォールバックする。
 */
export function eventTimestampToIso(timestamp: unknown): string {
    if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0) {
        const date = new Date(timestamp)
        if (!Number.isNaN(date.getTime())) {
            return date.toISOString()
        }
    }
    return new Date().toISOString()
}
