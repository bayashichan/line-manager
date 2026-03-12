import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { calculateNextSendAt } from '@/lib/utils'

/**
 * ステップ配信を処理するCronジョブ
 * GET /api/cron/step-messages
 * 
 * Vercel Cronから定期実行される（1分ごと推奨）
 */
export async function GET(request: NextRequest) {
    try {
        // CronシークレットをチェStepク（本番環境用）
        const authHeader = request.headers.get('authorization')
        if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: '認証エラー' }, { status: 401 })
        }

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
          line_user_id
        )
      `)
            .eq('status', 'active')
            .lte('next_send_at', now)
            .limit(50)

        if (error) {
            console.error('ステップ実行取得エラー:', error)
            return NextResponse.json({ error: '取得エラー' }, { status: 500 })
        }

        if (!executions || executions.length === 0) {
            return NextResponse.json({ processed: 0 })
        }

        let processedCount = 0

        for (const execution of executions) {
            try {
                const scenario = execution.step_scenarios as any
                const lineUser = execution.line_users as any
                const channel = scenario.channels as any

                // 現在のステップのメッセージを取得
                const stepMessages = (scenario.step_messages || []).sort(
                    (a: any, b: any) => a.step_order - b.step_order
                )
                const currentStepMessage = stepMessages.find(
                    (sm: any) => sm.step_order === execution.current_step
                )

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
                    // コンテンツの変換（リッチメッセージをFlex Messageに変換）
                    let contentArray = Array.isArray(currentStepMessage.content)
                        ? currentStepMessage.content
                        : [currentStepMessage.content]

                    const processedContent = contentArray.map((block: any) => {
                        // customActionsがある、または旧linkUrlがある場合はFlex Message化
                        if (block.type === 'image' && (block.customActions || block.linkUrl)) {
                            let action: any

                            if (block.customActions) {
                                // customActions優先
                                if (block.customActions.redirectUrl) {
                                    action = {
                                        type: 'uri',
                                        uri: block.customActions.redirectUrl
                                    }
                                } else {
                                    action = {
                                        type: 'postback',
                                        data: `action=custom&scenario_id=${scenario.id}`
                                    }
                                }
                            } else if (block.linkUrl) {
                                // 旧仕様互換
                                action = {
                                    type: 'uri',
                                    uri: block.linkUrl
                                }
                            }

                            return {
                                type: 'flex',
                                altText: '画像メッセージ',
                                contents: {
                                    type: 'bubble',
                                    body: {
                                        type: 'box',
                                        layout: 'vertical',
                                        contents: [
                                            {
                                                type: 'image',
                                                url: block.originalContentUrl,
                                                size: 'full',
                                                aspectRatio: block.aspectRatio ? `${block.aspectRatio}:1` : undefined,
                                                aspectMode: 'cover',
                                                action: action
                                            }
                                        ],
                                        paddingAll: '0px'
                                    }
                                }
                            }
                        }
                        return block
                    })

                    // {name}置換処理
                    const displayName = lineUser?.display_name || '友だち'
                    const personalizedContent = processedContent.map((block: any) => {
                        if (block.type === 'text' && block.text?.includes('{name}')) {
                            return {
                                ...block,
                                text: block.text.replace(/{name}/g, displayName)
                            }
                        }
                        return block
                    })

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

                // 次のステップを確認
                const nextStep = stepMessages.find(
                    (sm: any) => sm.step_order === execution.current_step + 1
                )

                if (nextStep) {
                    // 次のステップへ進む
                    const nextSendAt = calculateNextSendAt(
                        new Date(),
                        nextStep.delay_minutes,
                        nextStep.send_hour ?? null,
                        nextStep.send_minute ?? 0
                    )

                    await supabase
                        .from('step_executions')
                        .update({
                            current_step: execution.current_step + 1,
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

        return NextResponse.json({
            success: true,
            processed: processedCount,
        })
    } catch (error) {
        console.error('Cronジョブエラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
