/**
 * 送信時刻を過ぎたステップ配信を送る（1回の実行で最大50件）。
 *
 * /api/cron/step-messages と /api/cron/tick から呼ぶ。
 * 処理内容は以前 /api/cron/step-messages に直接書かれていたものと同じ。
 */

import { createAdminClient } from '@/lib/supabase/server'
import { LineClient, buildLineMessages, replaceNamePlaceholder } from '@/lib/line'
import { calculateNextSendAt } from '@/lib/utils'

/** 送信処理中の実行を他の Cron 実行から守る時間（分） */
const LEASE_MINUTES = 10

export async function deliverDueStepMessages(): Promise<{ ok: boolean; processed: number }> {
    const supabase = createAdminClient()
    const now = new Date().toISOString()

    // 送信時刻を過ぎたアクティブなステップ実行を取得
    const { data: executions, error } = await supabase
        .from('step_executions')
        .select(`
    *,
    step_scenarios (
      *,
      step_messages (*),
      channels (*)
    ),
    line_users (
      line_user_id,
      display_name
    )
  `)
        .eq('status', 'active')
        .lte('next_send_at', now)
        .limit(50)

    if (error) {
        console.error('ステップ実行取得エラー:', error)
        return { ok: false, processed: 0 }
    }

    if (!executions || executions.length === 0) {
        return { ok: true, processed: 0 }
    }

    let processedCount = 0

    for (const execution of executions) {
        try {
            // 送信する権利を取る（Cron が重なって同じ人に同じステップを2回送らないため）。
            // next_send_at を少し先に進めておき、取れた実行だけを処理する。
            // 途中で落ちても、LEASE_MINUTES 後の実行で再処理される。
            const { data: leased, error: leaseError } = await supabase
                .from('step_executions')
                .update({ next_send_at: new Date(Date.now() + LEASE_MINUTES * 60000).toISOString() })
                .eq('id', execution.id)
                .eq('status', 'active')
                .eq('next_send_at', execution.next_send_at)
                .select('id')
            if (leaseError || !leased || leased.length === 0) {
                continue
            }

            const scenario = execution.step_scenarios as any
            const lineUser = execution.line_users as any
            const channel = scenario.channels as any

            // 現在のステップのメッセージを時間の早い順にソートして取得
            const stepMessages = (scenario.step_messages || []).sort((a: any, b: any) => {
                if (a.delay_minutes !== b.delay_minutes) return a.delay_minutes - b.delay_minutes;
                const aHour = a.send_hour ?? 0;
                const bHour = b.send_hour ?? 0;
                if (aHour !== bHour) return aHour - bHour;
                return (a.send_minute ?? 0) - (b.send_minute ?? 0);
            });

            const currentIndex = stepMessages.findIndex(
                (sm: any) => sm.step_order === execution.current_step
            );
            const currentStepMessage = currentIndex >= 0 ? stepMessages[currentIndex] : null;

            if (!currentStepMessage || !lineUser?.line_user_id) {
                // ステップが見つからない場合は完了
                await supabase
                    .from('step_executions')
                    .update({
                        status: 'completed',
                        completed_at: now,
                    })
                    .eq('id', execution.id)

                processedCount++
                continue
            }

            // LINE クライアント作成
            const lineClient = new LineClient(channel.channel_access_token)

            // メッセージ送信
            try {
                // コンテンツの変換（アクション付き画像はFlex Messageになる）
                // 変換は一斉配信と共通（src/lib/line/message-content.ts）
                const lineMessages = buildLineMessages(currentStepMessage.content, {
                    postbackData: `action=custom&scenario_id=${scenario.id}`,
                })

                // {name}置換処理
                const personalizedContent = replaceNamePlaceholder(
                    lineMessages,
                    lineUser?.display_name
                )

                await lineClient.pushMessage(lineUser.line_user_id, personalizedContent)

                // チャット履歴への保存処理を追加
                let textContent = 'ステップ配信メッセージ'

                // contentが配列（複数メッセージ）の場合の簡易判定
                if (personalizedContent.length > 0) {
                    const firstMsg = personalizedContent[0]
                    if (firstMsg.type === 'text') {
                        textContent = firstMsg.text
                    } else if (firstMsg.type === 'image') {
                        textContent = '画像が送信されました'
                    } else if (firstMsg.type === 'video') {
                        textContent = '動画が送信されました'
                    } else if (firstMsg.type === 'template' || firstMsg.type === 'flex') {
                        textContent = firstMsg.altText || 'リッチメッセージが送信されました'
                    }
                }

                // 1. chat_messages へのINSERT（ブロックごとに保存）
                for (const block of personalizedContent) {
                    let contentType = block.type
                    if (block.type === 'template' || block.type === 'flex') {
                        contentType = block.type
                    }
                    await supabase.from('chat_messages').insert({
                        channel_id: channel.id,
                        line_user_id: execution.line_user_id,
                        sender: 'admin',
                        content_type: contentType,
                        content: block,
                        read_at: null,
                    })
                }

                // 2. line_users の更新
                await supabase
                    .from('line_users')
                    .update({
                        last_message_at: now,
                        last_message_content: textContent,
                    })
                    .eq('id', execution.line_user_id)

            } catch (sendError) {
                console.error(`ステップメッセージ送信エラー (${execution.id}):`, sendError)
            }

            // 次のステップを確認（時間順で次のインデックス）
            const nextStep = currentIndex >= 0 && currentIndex + 1 < stepMessages.length
                ? stepMessages[currentIndex + 1]
                : null

            if (nextStep) {
                // 次のステップへ進む（配信日時はシナリオ開始日時を基準にする）
                // step_executions の開始日時の列は started_at（created_at は存在しない）
                let baseDate = new Date(execution.started_at ?? execution.created_at)
                if (isNaN(baseDate.getTime())) {
                    baseDate = new Date()
                }
                const nextSendAt = calculateNextSendAt(
                    baseDate,
                    nextStep.delay_minutes,
                    nextStep.send_hour ?? null,
                    nextStep.send_minute ?? 0
                )

                await supabase
                    .from('step_executions')
                    .update({
                        current_step: nextStep.step_order, // 実際の step_order を保存
                        next_send_at: nextSendAt,
                    })
                    .eq('id', execution.id)
            } else {
                // シナリオ完了
                await supabase
                    .from('step_executions')
                    .update({
                        status: 'completed',
                        completed_at: now,
                    })
                    .eq('id', execution.id)
            }

            processedCount++
        } catch (err) {
            console.error(`ステップ実行 ${execution.id} の処理エラー:`, err)
        }
    }

    return { ok: true, processed: processedCount }
}
