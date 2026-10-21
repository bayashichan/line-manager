import { LineClient, hasNamePlaceholder, replaceNamePlaceholder, toErrorMessage } from '@/lib/line'
import type { LineMessage } from '@/lib/line/message-content'
import { chunk, runWithConcurrency } from '@/lib/utils'
import type { Recipient } from './recipients'

/** マルチキャスト1回で送れる人数（LINE の上限） */
const MULTICAST_LIMIT = 500

/**
 * {name} 入りの配信を1人ずつ送るときの同時送信数。
 * 10件ずつ送っていたころは1500人で数十秒かかり、途中で時間切れになるおそれがあった。
 * LINE の push の上限（毎秒2,000回）には十分収まる。
 */
const PERSONALIZED_PUSH_CONCURRENCY = 50

export type DeliveryResult = {
    successCount: number
    failureCount: number
    /** 最初に起きた失敗の理由（配信履歴に残す。LINEのエラー本文がないと原因が特定できないため） */
    firstError: string | null
}

/**
 * 配信対象の全員にメッセージを送る（一斉配信・予約配信で共通）。
 * {name} を含むときは1人ずつ名前を差し込んで push し、含まないときは500人ずつ multicast する。
 */
export async function deliverToRecipients(
    lineClient: LineClient,
    recipients: Recipient[],
    lineMessages: LineMessage[]
): Promise<DeliveryResult> {
    const result: DeliveryResult = { successCount: 0, failureCount: 0, firstError: null }
    const recordError = (error: unknown) => {
        if (!result.firstError) {
            result.firstError = toErrorMessage(error)
        }
    }

    if (hasNamePlaceholder(lineMessages)) {
        // {name} はマルチキャストでは置換できないので、1人ずつ送る
        await runWithConcurrency(recipients, PERSONALIZED_PUSH_CONCURRENCY, async (recipient) => {
            try {
                await lineClient.pushMessage(
                    recipient.line_user_id,
                    replaceNamePlaceholder(lineMessages, recipient.display_name)
                )
                result.successCount++
            } catch (error) {
                console.error(`個別送信エラー (${recipient.line_user_id}):`, error)
                recordError(error)
                result.failureCount++
            }
        })
        return result
    }

    for (const batch of chunk(recipients.map(r => r.line_user_id), MULTICAST_LIMIT)) {
        try {
            await lineClient.multicast(batch, lineMessages)
            result.successCount += batch.length
        } catch (error) {
            console.error('配信エラー:', error)
            recordError(error)
            result.failureCount += batch.length
        }
    }
    return result
}
