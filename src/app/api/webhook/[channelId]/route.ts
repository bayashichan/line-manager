import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { validateSignature, LineClient } from '@/lib/line'
import { calculateNextSendAt } from '@/lib/utils'
import type { Channel } from '@/types'

interface WebhookEvent {
    type: string
    timestamp: number
    source: {
        type: string
        userId?: string
        groupId?: string
        roomId?: string
    }
    replyToken?: string
    message?: {
        type: string
        id: string
        text?: string
    }
}

interface WebhookBody {
    destination: string
    events: WebhookEvent[]
}

/**
 * LINE Webhook エンドポイント
 * POST /api/webhook/[channelId]
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ channelId: string }> }
) {
    const { channelId } = await params

    try {
        // リクエストボディを取得
        const bodyText = await request.text()
        const signature = request.headers.get('x-line-signature')

        if (!signature) {
            return NextResponse.json(
                { error: '署名がありません' },
                { status: 400 }
            )
        }

        // チャンネル情報を取得
        const supabase = createAdminClient()
        const { data: channel, error: channelError } = await supabase
            .from('channels')
            .select('*')
            .eq('channel_id', channelId)
            .single()

        if (channelError || !channel) {
            console.error('チャンネルが見つかりません:', channelId)
            return NextResponse.json(
                { error: 'チャンネルが見つかりません' },
                { status: 404 }
            )
        }

        // 署名を検証
        if (!validateSignature(bodyText, signature, channel.channel_secret)) {
            console.error('署名検証に失敗しました')
            return NextResponse.json(
                { error: '署名が無効です' },
                { status: 401 }
            )
        }

        // イベントを処理
        const body: WebhookBody = JSON.parse(bodyText)
        const lineClient = new LineClient(channel.channel_access_token)

        // LMessageなどへのWebhook転送（リレー）
        if (channel.lmessage_webhook_url) {
            // 非同期で転送（エラーでもメイン処理は止めない）
            forwardWebhook(channel.lmessage_webhook_url, bodyText, request.headers)
                .catch(err => console.error('Webhook転送エラー:', err))
        }

        for (const event of body.events) {
            await processEvent(supabase, lineClient, channel, event)
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('Webhook処理エラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}

/**
 * イベントを処理
 */
async function processEvent(
    supabase: ReturnType<typeof createAdminClient>,
    lineClient: LineClient,
    channel: { id: string; default_rich_menu_id: string | null; auto_reply_tags: string[] | null },
    event: WebhookEvent
) {
    const userId = event.source.userId
    if (!userId) return

    switch (event.type) {
        case 'follow':
            await handleFollow(supabase, lineClient, channel, userId)
            break
        case 'unfollow':
            await handleUnfollow(supabase, channel.id, userId)
            break
        case 'message':
            // メッセージ受信時もユーザー情報を更新/作成する（既存の友だち対策）
            console.log('メッセージ受信:', event.message)
            await handleFollow(supabase, lineClient, channel, userId)
            // チャット履歴に保存
            await handleMessage(supabase, channel.id, userId, event.message)
            break
        case 'postback':
            await handlePostback(supabase, lineClient, channel, userId, (event as any).postback)
            break
        default:
            console.log('未処理のイベント:', event.type)
    }
}

/**
 * フォローイベント処理
 */
async function handleFollow(
    supabase: ReturnType<typeof createAdminClient>,
    lineClient: LineClient,
    channel: { id: string; default_rich_menu_id: string | null; auto_reply_tags: string[] | null },
    userId: string
) {
    try {
        // LINEからプロフィールを取得
        const profile = await lineClient.getProfile(userId)

        // 既存ユーザーを確認
        const { data: existingUser } = await supabase
            .from('line_users')
            .select('id, is_blocked')
            .eq('channel_id', channel.id)
            .eq('line_user_id', userId)
            .single()

        if (existingUser) {
            // 既存ユーザーの場合、ブロック解除として更新
            await supabase
                .from('line_users')
                .update({
                    display_name: profile.displayName,
                    picture_url: profile.pictureUrl,
                    status_message: profile.statusMessage,
                    is_blocked: false,
                    followed_at: new Date().toISOString(),
                })
                .eq('id', existingUser.id)
        } else {
            // 新規ユーザーを作成
            const { data: newUser, error } = await supabase
                .from('line_users')
                .insert({
                    channel_id: channel.id,
                    line_user_id: userId,
                    display_name: profile.displayName,
                    picture_url: profile.pictureUrl,
                    status_message: profile.statusMessage,
                    current_rich_menu_id: channel.default_rich_menu_id,
                })
                .select('id')
                .single()

            if (error) {
                console.error('ユーザー作成エラー:', error)
                return
            }

            // デフォルトリッチメニューを適用
            if (channel.default_rich_menu_id) {
                const { data: richMenu } = await supabase
                    .from('rich_menus')
                    .select('rich_menu_id')
                    .eq('id', channel.default_rich_menu_id)
                    .single()

                if (richMenu?.rich_menu_id) {
                    await lineClient.linkRichMenuToUser(userId, richMenu.rich_menu_id)
                }
            }

            // 自動タグ付け処理
            if (channel.auto_reply_tags && channel.auto_reply_tags.length > 0) {
                const tagInserts = channel.auto_reply_tags.map(tagId => ({
                    line_user_id: newUser.id,
                    tag_id: tagId,
                }))

                const { error: tagError } = await supabase
                    .from('line_user_tags')
                    .insert(tagInserts)

                if (tagError) {
                    console.error('自動タグ付けエラー:', tagError)
                } else {
                    console.log(`自動タグ付け完了: ${tagInserts.length} 件`)

                    // タグに応じたリッチメニュー切り替え判定
                    // 新規ユーザーなのでデフォルトが適用済みだが、タグ優先度が高いものがあれば上書きする
                    await supabase.rpc('determine_rich_menu_for_user', {
                        p_line_user_id: newUser.id
                    })
                }
            }

            // フォロートリガーのステップ配信を開始
            await startFollowStepScenarios(supabase, channel.id, newUser.id)
        }

        console.log(`友だち追加: ${profile.displayName} (${userId})`)
    } catch (error) {
        console.error('フォロー処理エラー:', error)
    }
}

/**
 * アンフォローイベント処理
 */
async function handleUnfollow(
    supabase: ReturnType<typeof createAdminClient>,
    channelId: string,
    userId: string
) {
    try {
        await supabase
            .from('line_users')
            .update({ is_blocked: true })
            .eq('channel_id', channelId)
            .eq('line_user_id', userId)

        console.log(`友だちブロック / 削除: ${userId} `)
    } catch (error) {
        console.error('アンフォロー処理エラー:', error)
    }
}

/**
 * フォロートリガーのステップ配信を開始
 */
async function startFollowStepScenarios(
    supabase: ReturnType<typeof createAdminClient>,
    channelId: string,
    lineUserId: string
) {
    // フォロートリガーのアクティブなシナリオを取得
    const { data: scenarios } = await supabase
        .from('step_scenarios')
        .select(`
id,
    step_messages(
        delay_minutes,
        send_hour
    )
        `)
        .eq('channel_id', channelId)
        .eq('trigger_type', 'follow')
        .eq('is_active', true)
        .order('step_messages(step_order)', { ascending: true })

    if (!scenarios || scenarios.length === 0) return

    for (const scenario of scenarios) {
        const firstMessage = scenario.step_messages?.[0]
        const delayMinutes = firstMessage?.delay_minutes || 0
        const sendHour = firstMessage?.send_hour ?? null
        const nextSendAt = calculateNextSendAt(new Date(), delayMinutes, sendHour)

        await supabase.from('step_executions').insert({
            scenario_id: scenario.id,
            line_user_id: lineUserId,
            current_step: 1,
            next_send_at: nextSendAt,
        })
    }
}

/**
 * メッセージ受信イベント処理
 */
async function handleMessage(
    supabase: ReturnType<typeof createAdminClient>,
    channelId: string,
    lineUserId: string,
    message: any
) {
    if (!message) return

    try {
        // line_usersテーブルのIDを取得（LINEのユーザーIDではなく、内部UUIDが必要）
        const { data: user } = await supabase
            .from('line_users')
            .select('id, unread_count')
            .eq('channel_id', channelId)
            .eq('line_user_id', lineUserId)
            .single()

        if (!user) return

        // メッセージを保存
        const { error: msgError } = await supabase
            .from('chat_messages')
            .insert({
                channel_id: channelId,
                line_user_id: user.id,
                sender: 'user',
                content_type: message.type,
                content: message,
            })

        if (msgError) {
            console.error('メッセージ保存エラー:', msgError)
            return
        }

        // メッセージ内容のテキスト化
        const messageText = message.type === 'text' ? message.text :
            message.type === 'image' ? '画像が送信されました' :
                message.type === 'video' ? '動画が送信されました' :
                    'メッセージが送信されました'

        // ユーザー情報の更新（最終メッセージ日時、未読数）
        await supabase
            .from('line_users')
            .update({
                last_message_at: new Date().toISOString(),
                unread_count: (user.unread_count || 0) + 1,
                last_message_content: messageText,
            })
            .eq('id', user.id)

    } catch (error) {
        console.error('メッセージ処理エラー:', error)
    }
}

/**
 * Postbackイベント処理
 */
async function handlePostback(
    supabase: ReturnType<typeof createAdminClient>,
    lineClient: LineClient,
    channel: { id: string },
    lineUserId: string,
    postback: { data: string, params?: any }
) {
    try {
        const params = new URLSearchParams(postback.data)
        const action = params.get('action')
        const messageId = params.get('mid')

        if (action === 'custom' && messageId) {
            // メッセージ取得
            const { data: message } = await supabase
                .from('messages')
                .select('content')
                .eq('id', messageId)
                .single()

            if (!message) return

            // アクション情報取得
            // 簡易的に最初の画像メッセージのカスタムアクションを使用
            const imageContent = (message.content as any[]).find(c => c.type === 'image')
            const actions = imageContent?.customActions

            if (!actions) return

            // ユーザーID解決
            const { data: user } = await supabase
                .from('line_users')
                .select('id, display_name')
                .eq('channel_id', channel.id)
                .eq('line_user_id', lineUserId)
                .single()

            if (!user) return

            // 1. タグ付け
            if (actions.tagIds && actions.tagIds.length > 0) {
                const tagInserts = actions.tagIds.map((tagId: string) => ({
                    line_user_id: user.id,
                    tag_id: tagId
                }))
                await supabase.from('line_user_tags').upsert(tagInserts, { onConflict: 'line_user_id,tag_id' })
            }

            // 2. ステップ配信開始
            if (actions.scenarioId) {
                const { data: scenario } = await supabase
                    .from('step_scenarios')
                    .select('*, step_messages(*)')
                    .eq('id', actions.scenarioId)
                    .single()

                if (scenario && scenario.step_messages.length > 0) {
                    const firstMsg = scenario.step_messages.sort((a: any, b: any) => a.step_order - b.step_order)[0]
                    const delayMinutes = firstMsg.delay_minutes
                    const sendHour = firstMsg.send_hour ?? null
                    const nextSendAt = calculateNextSendAt(new Date(), delayMinutes, sendHour)

                    await supabase.from('step_executions').insert({
                        scenario_id: scenario.id,
                        line_user_id: user.id,
                        current_step: 1,
                        next_send_at: nextSendAt,
                        status: 'active'
                    })
                }
            }

            // 3. テキスト返信
            if (actions.replyText) {
                const replyText = actions.replyText.replace(/{name}/g, user.display_name || '友だち')

                // Postbackに対する応答としてreplyMessageを使用したいが、ここではreplyTokenが渡されていない
                // なのでpushMessageを使用する。もしreplyTokenがあればreplyMessageを使うべき。
                await lineClient.pushMessage(lineUserId, [{ type: 'text', text: replyText }])
            }

            console.log(`カスタムアクション実行完了: ${messageId} -> ${lineUserId} `)
        }
    } catch (error) {
        console.error('Postback処理エラー:', error)
    }
}

/**
 * Webhookを外部へ転送
 */
async function forwardWebhook(url: string, bodyText: string, headers: Headers) {
    const signature = headers.get('x-line-signature')

    if (!signature) return

    await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-line-signature': signature
        },
        body: bodyText
    })
    console.log(`Webhook転送成功: ${url} `)
}
