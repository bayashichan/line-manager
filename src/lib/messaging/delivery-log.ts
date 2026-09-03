import type { SupabaseClient } from '@supabase/supabase-js'
import type { LineMessage } from '@/lib/line'
import { chunk } from '@/lib/utils'
import type { Recipient } from '@/lib/messaging/recipients'

/**
 * 一斉配信・予約配信の「誰に届いて、誰が読んだか」を残すための記録処理。
 *
 * これまで配信結果は messages の成功/失敗件数だけで、友だち単位の記録が無かった。
 * 友だちごとの既読状況を出すには、まず「誰に送ったか」が行として残っている必要があるため、
 * 送信直後に message_recipients を作る。
 *
 * あわせて chat_messages にも書き込み、一斉配信が1:1チャットのトーク履歴に並ぶようにする。
 * LINE公式アカウントアプリのトーク画面では配信も個別チャットも同じ流れで表示されるので、
 * 管理画面でも同じ見え方にしないと、担当者が「何を送った相手なのか」を追えない。
 */

export type DeliveryOutcome = {
    status: 'sent' | 'failed'
    error: string | null
}

/** 1リクエストあたりの挿入行数。多すぎるとPostgRESTのペイロード上限に当たる */
const INSERT_CHUNK_SIZE = 500

/**
 * 1:1チャットへ複製する行数の上限。
 * 友だち数 × メッセージブロック数だけ行が増えるため、大規模配信では
 * Serverless関数の実行時間を使い切ってしまう。上限を超えた場合は
 * 配信対象の記録（＝既読集計に必要な方）だけ残し、トーク履歴への複製は諦める。
 */
const MAX_THREAD_SYNC_ROWS = 20000

export type RecordBroadcastParams = {
    channelId: string
    messageId: string
    /** 配信対象（resolveRecipientsの戻り値） */
    recipients: Recipient[]
    /** LINEユーザーIDごとの送信結果 */
    outcomes: Map<string, DeliveryOutcome>
    /** 実際にLINEへ送ったメッセージ本体 */
    blocks: LineMessage[]
    /** 送信時刻（ISO8601） */
    sentAt: string
}

/**
 * 配信結果を友だち単位で保存する。
 *
 * 記録に失敗しても配信自体は成功しているので、例外は投げずログに残すだけにする。
 * ここで throw すると、送信済みなのにAPIが500を返して二重配信を誘発する。
 */
export async function recordBroadcastDelivery(
    client: SupabaseClient,
    { channelId, messageId, recipients, outcomes, blocks, sentAt }: RecordBroadcastParams
): Promise<void> {
    if (recipients.length === 0) return

    const rows = recipients.map(recipient => {
        const outcome = outcomes.get(recipient.line_user_id) ?? { status: 'sent' as const, error: null }
        return {
            recipient,
            outcome,
        }
    })

    // 1. 配信対象の記録（既読集計のベースになるので、こちらは必ず書く）
    const recipientRows = rows.map(({ recipient, outcome }) => ({
        message_id: messageId,
        line_user_id: recipient.id,
        status: outcome.status,
        error_message: outcome.error,
        // 失敗した相手に sent_at を入れると「送ったのに未読」に見えてしまうので入れない
        sent_at: outcome.status === 'sent' ? sentAt : null,
    }))

    for (const batch of chunk(recipientRows, INSERT_CHUNK_SIZE)) {
        const { error } = await client
            .from('message_recipients')
            // 再実行時に同じ配信の行が増えないようユニークキーで上書きする
            .upsert(batch, { onConflict: 'message_id,line_user_id' })

        if (error) {
            console.error('配信対象の記録エラー:', error)
        }
    }

    // 2. 1:1チャットへの複製（届いた相手のぶんだけ）
    const delivered = rows.filter(({ outcome }) => outcome.status === 'sent')
    const threadRowCount = delivered.length * blocks.length

    if (blocks.length === 0 || delivered.length === 0) return

    if (threadRowCount > MAX_THREAD_SYNC_ROWS) {
        console.warn(
            `1:1チャットへの複製をスキップしました（${threadRowCount}行 > 上限${MAX_THREAD_SYNC_ROWS}行）。` +
            '配信対象の記録と既読集計は通常どおり行われます。'
        )
        return
    }

    const chatRows = delivered.flatMap(({ recipient }) =>
        blocks.map(block => ({
            channel_id: channelId,
            line_user_id: recipient.id,
            sender: 'admin',
            content_type: typeof block.type === 'string' ? block.type : 'text',
            content: block,
            read_at: null,
            delivery_source: 'broadcast',
            message_id: messageId,
        }))
    )

    for (const batch of chunk(chatRows, INSERT_CHUNK_SIZE)) {
        const { error } = await client.from('chat_messages').insert(batch)
        if (error) {
            console.error('1:1チャットへの配信複製エラー:', error)
        }
    }

    // 友だちリストの並び順（last_message_at）は意図的に更新していない。
    // 一斉配信で全員を先頭に押し上げると、返信待ちの相手が埋もれて実務で使えなくなるため。
}
