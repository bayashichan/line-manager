/**
 * 送信時刻を過ぎたステップ配信を送る。
 *
 * /api/cron/step-messages と /api/cron/tick から呼ぶ。
 * 送る対象（最大1000件）を時刻の早い順に先に決め、50件ずつ10件並行で、時間の目安（既定25秒）まで送る。
 * 以前は1回の実行で50件までだったため、同じ時刻に送る人が多いと（例: 朝9時に1000人）
 * 最後の人に届くまで1時間以上かかっていた。
 */

import { createAdminClient } from '@/lib/supabase/server'
import { LineClient, buildLineMessages, replaceNamePlaceholder } from '@/lib/line'
import { calculateNextSendAt, chunk, runWithConcurrency } from '@/lib/utils'

type AdminClient = ReturnType<typeof createAdminClient>

/** 送信処理中の実行を他の Cron 実行から守る時間（分） */
const LEASE_MINUTES = 10

/** 1回の実行で送る対象の上限（残りは次の回に送る） */
const MAX_PER_RUN = 1000

/** まとめて取り出す件数（id の IN 句が URL 長の上限に当たらない数） */
const BATCH_SIZE = 50

/** 同時に送る件数（1件ずつ送信する権利を取ってから送るので、並行しても同じ人に2回は送らない） */
const CONCURRENCY = 10

/** 1回の実行で送り続ける時間の目安。/api/cron/tick（上限60秒）のほかの処理の時間を残す */
const DEFAULT_TIME_BUDGET_MS = 25_000

/**
 * 送る対象の実行を中身ごと取る。送信時刻の条件も付け直す: 対象を決めたあとに別の Cron 実行が
 * 送信の権利を取った（next_send_at を先に進めた）実行は、ここで外れる（同じ人に2回送らないため）
 */
function fetchExecutions(supabase: AdminClient, ids: string[], now: string) {
    return supabase
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
        .in('id', ids)
        .eq('status', 'active')
        .lte('next_send_at', now)
}

type DueExecution = NonNullable<Awaited<ReturnType<typeof fetchExecutions>>['data']>[number]

export async function deliverDueStepMessages(
    options: { timeBudgetMs?: number } = {}
): Promise<{ ok: boolean; processed: number }> {
    const supabase = createAdminClient()
    const startedAt = Date.now()
    const deadline = startedAt + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS)
    const now = new Date(startedAt).toISOString()

    // 送信時刻を過ぎたアクティブなステップ実行を、時刻の早い順に、この回で送る分として先に決める。
    // 送ったあと次のステップの時刻がもう過ぎていても、同じ回には続けて送らない
    // （これまでどおり、1回の実行で1人に送るのは1ステップまで）
    const { data: due, error } = await supabase
        .from('step_executions')
        .select('id')
        .eq('status', 'active')
        .lte('next_send_at', now)
        .order('next_send_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(MAX_PER_RUN)

    if (error) {
        console.error('ステップ実行取得エラー:', error)
        return { ok: false, processed: 0 }
    }

    let processedCount = 0

    for (const ids of chunk((due ?? []).map(d => d.id as string), BATCH_SIZE)) {
        // 時間切れで途中になった分は、送信の権利を取っていないので次の回にそのまま送られる
        if (Date.now() >= deadline) break

        const { data: executions, error: fetchError } = await fetchExecutions(supabase, ids, now)
        if (fetchError) {
            console.error('ステップ実行取得エラー:', fetchError)
            return { ok: false, processed: processedCount }
        }

        await runWithConcurrency(executions ?? [], CONCURRENCY, async execution => {
            if (await deliverExecution(supabase, execution, now)) processedCount++
        })
    }

    return { ok: true, processed: processedCount }
}

/** 1件のステップ実行を送り、次のステップへ進める。処理した（送った・完了にした）ら true */
async function deliverExecution(supabase: AdminClient, execution: DueExecution, now: string): Promise<boolean> {
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
            return false
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

            return true
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

        return true
    } catch (err) {
        console.error(`ステップ実行 ${execution.id} の処理エラー:`, err)
        return false
    }
}
