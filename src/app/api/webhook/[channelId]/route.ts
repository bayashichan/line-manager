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
 * タイムアウト付きfetch（LINE APIのハング対策）
 */
async function fetchWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    fallback: T
): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<T>((resolve) => {
        timer = setTimeout(() => {
            console.warn(`タイムアウト (${timeoutMs}ms) - フォールバック値を使用`)
            resolve(fallback)
        }, timeoutMs)
    })
    try {
        const result = await Promise.race([promise, timeout])
        return result
    } finally {
        clearTimeout(timer!)
    }
}

/**
 * フォローイベント処理（最適化版）
 * 
 * 設計方針:
 * - ユーザー保存（upsert）を最優先で確実に実行 → 友だち一覧に必ず表示
 * - プロフィール取得は3秒タイムアウト → LINE API遅延時も処理続行
 * - リッチメニュー/タグ付け/ステップ配信は非同期 → タイムアウト回避
 */
async function handleFollow(
    supabase: ReturnType<typeof createAdminClient>,
    lineClient: LineClient,
    channel: { id: string; default_rich_menu_id: string | null; auto_reply_tags: string[] | null },
    userId: string
) {
    try {
        // ====================================================================
        // STEP 1: プロフィール取得（3秒タイムアウト付き）
        // ====================================================================
        const defaultProfile = { userId, displayName: '不明なユーザー', pictureUrl: undefined, statusMessage: undefined }
        const profile = await fetchWithTimeout(
            lineClient.getProfile(userId),
            3000,
            defaultProfile
        )

        // ====================================================================
        // STEP 2: ユーザー保存（upsert - これが最重要。ここだけは絶対に成功させる）
        // select + insert/update の2回を1回に統合し、処理時間を短縮
        // ====================================================================
        const { data: upsertedUser, error: upsertError } = await supabase
            .from('line_users')
            .upsert(
                {
                    channel_id: channel.id,
                    line_user_id: userId,
                    display_name: profile.displayName,
                    picture_url: profile.pictureUrl,
                    status_message: profile.statusMessage,
                    is_blocked: false,
                    followed_at: new Date().toISOString(),
                },
                {
                    onConflict: 'channel_id,line_user_id',
                }
            )
            .select('id')
            .single()

        if (upsertError || !upsertedUser) {
            // ここが失敗 = 友だちが一覧に表示されない。絶対にログを残す
            console.error(`【致命的】ユーザー保存失敗 (userId: ${userId}, channel: ${channel.id}):`, upsertError)
            return
        }

        console.log(`友だち追加/更新: ${profile.displayName} (${userId}) → DB ID: ${upsertedUser.id}`)

        // ====================================================================
        // STEP 3: 副次処理を実行（確実に完了させるためawait）
        // ユーザー保存は完了済みなので、以下が失敗しても友だち一覧には表示される
        // ====================================================================
        await runSecondaryTasks(supabase, lineClient, channel, userId, upsertedUser.id)
            .catch(err => console.error(`副次処理エラー (userId: ${userId}):`, err))

    } catch (error) {
        console.error(`フォロー処理エラー (userId: ${userId}):`, error)
    }
}

/**
 * 副次処理（リッチメニュー適用、タグ付け、ステップ配信）
 * handleFollowから非同期で呼ばれる。失敗しても友だち登録自体は完了済み。
 */
async function runSecondaryTasks(
    supabase: ReturnType<typeof createAdminClient>,
    lineClient: LineClient,
    channel: { id: string; default_rich_menu_id: string | null; auto_reply_tags: string[] | null },
    lineUserId: string,
    internalUserId: string
) {
    // デフォルトリッチメニューを適用
    if (channel.default_rich_menu_id) {
        try {
            const { data: richMenu } = await supabase
                .from('rich_menus')
                .select('rich_menu_id')
                .eq('id', channel.default_rich_menu_id)
                .single()

            if (richMenu?.rich_menu_id) {
                await lineClient.linkRichMenuToUser(lineUserId, richMenu.rich_menu_id)
            }
        } catch (err) {
            console.error(`リッチメニュー適用エラー (userId: ${lineUserId}):`, err)
        }
    }

    // 自動タグ付け処理
    if (channel.auto_reply_tags && channel.auto_reply_tags.length > 0) {
        try {
            const tagInserts = channel.auto_reply_tags.map(tagId => ({
                line_user_id: internalUserId,
                tag_id: tagId,
            }))

            const { error: tagError } = await supabase
                .from('line_user_tags')
                .insert(tagInserts)

            if (tagError) {
                console.error(`自動タグ付けエラー (userId: ${lineUserId}):`, tagError)
            } else {
                console.log(`自動タグ付け完了: ${tagInserts.length} 件 (userId: ${lineUserId})`)

                await supabase.rpc('determine_rich_menu_for_user', {
                    p_line_user_id: internalUserId
                })
            }
        } catch (err) {
            console.error(`タグ処理エラー (userId: ${lineUserId}):`, err)
        }
    }

    // フォロートリガーのステップ配信を開始
    try {
        await startFollowStepScenarios(supabase, channel.id, internalUserId)
    } catch (err) {
        console.error(`ステップ配信開始エラー (userId: ${lineUserId}):`, err)
    }

    // Meta CAPI送信（awaitで確実に完了させる）
    try {
        await sendMetaCapiEvent(supabase, channel.id, lineUserId)
    } catch (err) {
        console.error(`Meta CAPI送信エラー (userId: ${lineUserId}):`, err)
    }
}



/**
 * Meta Conversions API へ Lead イベントを送信
 */
async function sendMetaCapiEvent(
    supabase: ReturnType<typeof createAdminClient>,
    channelId: string,
    lineUserId: string
) {
    const pixelId = process.env.META_PIXEL_ID
    const accessToken = process.env.META_ACCESS_TOKEN
    if (!pixelId || !accessToken) {
        console.warn('Meta CAPI環境変数未設定 (META_PIXEL_ID / META_ACCESS_TOKEN)')
        return
    }

    // ad_conversionsテーブルからpendingレコードを検索
    const { data: conversion } = await supabase
        .from('ad_conversions')
        .select('id, fbclid')
        .eq('channel_id', channelId)
        .eq('line_user_id', lineUserId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

    if (!conversion) {
        // 広告経由以外の友だち追加（正常）
        return
    }

    const eventTime = Math.floor(Date.now() / 1000)
    const fbcValue = conversion.fbclid
        ? `fb.1.${Date.now()}.${conversion.fbclid}`
        : undefined

    // Meta CAPI へ Lead イベントを送信
    const payload: Record<string, unknown> = {
        data: [
            {
                event_name: 'Lead',
                event_time: eventTime,
                action_source: 'website',
                user_data: {
                    ...(fbcValue ? { fbc: fbcValue } : {}),
                },
            },
        ],
    }

    // テストイベントコードがあればデバッグモードで送信
    if (process.env.META_TEST_EVENT_CODE) {
        payload.test_event_code = process.env.META_TEST_EVENT_CODE
    }

    const res = await fetch(
        `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }
    )

    // statusを先に更新（Webhook到達確認のため）
    await supabase
        .from('ad_conversions')
        .update({
            status: 'converted',
            converted_at: new Date().toISOString(),
        })
        .eq('id', conversion.id)

    if (!res.ok) {
        const errText = await res.text()
        console.error(`Meta CAPI APIエラー (userId: ${lineUserId}):`, errText)
        return
    }

    console.log(`Meta CAPI送信成功 (userId: ${lineUserId}, fbclid: ${conversion.fbclid ?? 'なし'})`)
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
        send_hour,
        send_minute
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
        const sendMinute = firstMessage?.send_minute ?? 0
        const nextSendAt = calculateNextSendAt(new Date(), delayMinutes, sendHour, sendMinute)

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
                    const sendMinute = firstMsg.send_minute ?? 0
                    const nextSendAt = calculateNextSendAt(new Date(), delayMinutes, sendHour, sendMinute)

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
