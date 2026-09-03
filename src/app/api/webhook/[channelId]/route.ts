import { NextRequest, NextResponse } from 'next/server'
import { Client } from '@upstash/qstash'
import { createAdminClient } from '@/lib/supabase/server'
import { validateSignature, LineClient, findMatchingAutoReply, personalizeContent } from '@/lib/line'
import type { AutoReply } from '@/types'
import { calculateNextSendAt } from '@/lib/utils'
import type { Channel } from '@/types'
import { sendMetaCapiEvent } from '@/lib/meta-capi'
import {
    eventTimestampToIso,
    markFriendReadUpTo,
    resolveLineUserRowId,
    type ReadSource,
} from '@/lib/chat/read-receipts'
import { normalizeIncomingMessage } from '@/lib/chat/incoming'

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
        [key: string]: unknown
    }
    /** unsendイベント（送信取消）で取り消されたメッセージ */
    unsend?: {
        messageId: string
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
            await handleFollow(supabase, lineClient, channel, userId, { sendCapi: true, updateFollowedAt: true })
            break
        case 'unfollow':
            await handleUnfollow(supabase, channel.id, userId)
            break
        case 'message':
            console.log('メッセージ受信:', event.message)
            // 自動応答を最優先で処理する。
            // replyTokenは短時間で失効するため、プロフィール取得(最大3秒)やQStash発行を
            // 含む handleFollow より必ず先に返信すること。順序を入れ替えると応答APIが
            // 使えなくなり、課金対象のプッシュに頼らざるを得なくなる。
            await handleAutoReply(supabase, lineClient, channel.id, userId, event.message, event.replyToken)
            // メッセージ受信時もユーザー情報を更新/作成する（既存の友だち対策）。
            // ただし Meta CAPI は friend追加イベントのみで発火させる。既存友だちの
            // メッセージで再発火させると Lead が重複計上される可能性があるため。
            // followed_at も更新しない（メッセージのたびに友だち追加日時が
            // 上書きされ、一覧の登録日・並び順が壊れるため）。
            await handleFollow(supabase, lineClient, channel, userId, { sendCapi: false, updateFollowedAt: false })
            // チャット履歴に保存
            await handleMessage(supabase, lineClient, channel.id, userId, event.message)
            // 返信をくれたということはトークを開いている。
            // 既読の境界はイベント発生時刻なので、この直後に送った自動応答は未読のまま残る（意図どおり）。
            await markRead(supabase, channel.id, userId, event, 'message')
            break
        case 'postback':
            await handlePostback(supabase, lineClient, channel, userId, (event as any).postback)
            // ボタンやリッチメニューをタップした = トークを開いている
            await markRead(supabase, channel.id, userId, event, 'postback')
            break
        case 'unsend':
            await handleUnsend(supabase, channel.id, event.unsend?.messageId)
            break
        case 'videoPlayComplete':
            // 配信した動画を最後まで再生した = トークを開いている
            await markRead(supabase, channel.id, userId, event, 'other')
            break
        default:
            console.log('未処理のイベント:', event.type)
    }
}

/**
 * みなし既読の反映。
 *
 * LINEは既読を通知してくれないので、友だち自身の操作（返信・タップ・動画再生）を
 * 「トークを開いた」証跡として扱い、それ以前に送ったメッセージを既読にする。
 * 既読はあくまで補助情報なので、ここで失敗してもWebhookの主処理は止めない。
 */
async function markRead(
    supabase: ReturnType<typeof createAdminClient>,
    channelId: string,
    lineUserId: string,
    event: WebhookEvent,
    source: ReadSource
) {
    try {
        const rowId = await resolveLineUserRowId(supabase, channelId, lineUserId)
        if (!rowId) return

        await markFriendReadUpTo(supabase, {
            channelId,
            lineUserRowId: rowId,
            // 処理時刻ではなくイベント発生時刻を使う。Webhookが遅延しても既読の境界がぶれない
            readAt: eventTimestampToIso(event.timestamp),
            source,
        })
    } catch (error) {
        console.error(`既読反映エラー (userId: ${lineUserId}):`, error)
    }
}

/**
 * 送信取消（unsend）イベント処理。
 *
 * 友だちがLINE上でメッセージを取り消したのに管理画面に残り続けると、
 * 実際のトーク画面と食い違って混乱のもとになるため、取り消し済みとして記録する。
 */
async function handleUnsend(
    supabase: ReturnType<typeof createAdminClient>,
    channelId: string,
    messageId: string | undefined
) {
    if (!messageId) return

    try {
        const { error } = await supabase
            .from('chat_messages')
            .update({
                unsent_at: new Date().toISOString(),
                content: { type: 'unsend' },
                content_type: 'unsend',
            })
            .eq('channel_id', channelId)
            .eq('line_message_id', messageId)

        if (error) {
            console.error('送信取消の反映エラー:', error)
        }
    } catch (error) {
        console.error('送信取消の処理エラー:', error)
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
    userId: string,
    options: { sendCapi: boolean; updateFollowedAt: boolean }
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
        // followed_at は follow イベント時のみ明示的に指定する。
        // 未指定なら新規行は DB の DEFAULT NOW() が入り、既存行は元の値が保持される。
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
                    ...(options.updateFollowedAt ? { followed_at: new Date().toISOString() } : {}),
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
        // STEP 2.5: line_sessions照合 → ad_conversions事前生成
        // LP広告クリック時のfbclid等をline_sessionsから取得し、
        // sendMetaCapiEventが参照できるようad_conversionsにpending行を作成する。
        // ====================================================================
        if (options.sendCapi) {
            try {
                const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
                const { data: session } = await supabase
                    .from('line_sessions')
                    .select('id, fbclid, fbp, fbc, user_agent')
                    .eq('channel_id', channel.id)
                    .gte('clicked_at', tenMinutesAgo)
                    .is('line_user_id', null)
                    .order('clicked_at', { ascending: false })
                    .limit(1)
                    .maybeSingle()

                if (session) {
                    const clickTimeMs = Date.now()
                    const resolvedFbc = session.fbc ?? (session.fbclid ? `fb.1.${clickTimeMs}.${session.fbclid}` : null)

                    const [, insertResult] = await Promise.all([
                        supabase
                            .from('line_sessions')
                            .update({ line_user_id: userId, matched_at: new Date().toISOString() })
                            .eq('id', session.id),
                        supabase
                            .from('ad_conversions')
                            .insert({
                                channel_id: channel.id,
                                line_user_id: userId,
                                fbclid: session.fbclid ?? null,
                                fbp: session.fbp ?? null,
                                fbc: resolvedFbc,
                                user_agent: session.user_agent ?? null,
                                click_time_ms: clickTimeMs,
                            }),
                    ])

                    if (insertResult.error) {
                        console.error(`ad_conversions INSERT from line_sessions error (userId: ${userId}):`, insertResult.error)
                    } else {
                        console.log(`line_sessions照合成功: fbclid=${session.fbclid ?? 'なし'} (userId: ${userId})`)
                    }
                }
            } catch (err) {
                console.error(`line_sessions照合エラー (userId: ${userId}):`, err)
            }
        }

        // ====================================================================
        // STEP 3: Meta CAPI 送信（follow イベントのみ。message での再発火を防ぐ）
        // line_sessions照合済みの場合はSTEP 2.5で作成したad_conversionsを参照する。
        // 照合なしの場合はフォールバックとして既存のad_conversionsを使用する。
        // ====================================================================
        if (options.sendCapi) {
            try {
                await sendMetaCapiEvent(supabase, channel.id, userId)
            } catch (err) {
                console.error(`Meta CAPI送信エラー (userId: ${userId}):`, err)
            }
        }

        // ====================================================================
        // STEP 4: 副次処理を実行（確実に完了させるためawait）
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
    // Meta CAPI送信は handleFollow 側で follow イベント時のみ呼び出すため、ここでは行わない。
    // リッチメニュー・タグ付け・ステップ配信をQStash経由で非同期実行
    // Vercelの10秒タイムアウトを回避し、確実に完了させる
    const qstashToken = process.env.QSTASH_TOKEN
    if (qstashToken) {
        try {
            const qstashClient = new Client({ token: qstashToken })
            const baseUrl = process.env.NEXT_PUBLIC_VERCEL_URL
                ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
                : process.env.VERCEL_URL
                    ? `https://${process.env.VERCEL_URL}`
                    : 'https://line-manager-omega.vercel.app'

            await qstashClient.publishJSON({
                url: `${baseUrl}/api/webhook/qstash-secondary`,
                body: {
                    channelId: channel.id,
                    lineUserId,
                    internalUserId,
                },
                retries: 3,
            })
            console.log(`QStash副次処理キュー送信完了 (userId: ${lineUserId})`)
        } catch (err) {
            console.error(`QStash送信失敗、直接実行にフォールバック (userId: ${lineUserId}):`, err)
            // QStash失敗時は直接実行（ベストエフォート）
            await executeSecondaryTasksDirectly(supabase, lineClient, channel, lineUserId, internalUserId)
        }
    } else {
        // QStash未設定時は直接実行
        await executeSecondaryTasksDirectly(supabase, lineClient, channel, lineUserId, internalUserId)
    }
}



/**
 * 副次処理を直接実行（QStash未設定時・失敗時のフォールバック）
 */
async function executeSecondaryTasksDirectly(
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
                .upsert(tagInserts, { onConflict: 'line_user_id,tag_id' })

            if (tagError) {
                console.error(`タグ処理エラー (userId: ${lineUserId}):`, tagError)
            } else {
                console.log(`自動タグ付け完了: ${tagInserts.length} 件 (userId: ${lineUserId})`)
            }

            const { recalculateAndSwitchUserRichMenu } = await import('@/lib/rich-menu')
            await recalculateAndSwitchUserRichMenu(internalUserId)
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
 * キーワード自動応答
 *
 * 応答（Reply）APIで返信する。応答メッセージはLINEのメッセージ通数に
 * カウントされないため、この返信は送信枠を消費しない。
 *
 * 【重要】replyMessageが失敗してもpushMessageにフォールバックしないこと。
 * フォールバックすると気付かないうちに課金対象の送信が発生し、
 * この機能の目的（送信枠ゼロでの自動応答）が崩れる。
 */
async function handleAutoReply(
    supabase: ReturnType<typeof createAdminClient>,
    lineClient: LineClient,
    channelId: string,
    lineUserId: string,
    message: WebhookEvent['message'],
    replyToken: string | undefined
) {
    // 応答APIはreplyTokenが必須。テキスト以外はキーワード判定できないので対象外。
    if (!replyToken) return
    if (!message || message.type !== 'text' || !message.text) return

    try {
        const { data: rules, error } = await supabase
            .from('auto_replies')
            .select('*')
            .eq('channel_id', channelId)
            .eq('is_active', true)

        if (error) {
            console.error('自動応答ルール取得エラー:', error)
            return
        }
        if (!rules || rules.length === 0) return

        const rule = findMatchingAutoReply(rules as AutoReply[], message.text)
        if (!rule) return

        // 表示名は {name} 置換にしか使わないので、取得できなくても応答は続行する
        const { data: user } = await supabase
            .from('line_users')
            .select('id, display_name')
            .eq('channel_id', channelId)
            .eq('line_user_id', lineUserId)
            .single()

        const content = personalizeContent(rule.content, user?.display_name)

        await lineClient.replyMessage(replyToken, content)
        console.log(`自動応答送信: ${rule.name} -> ${lineUserId}（送信枠の消費なし）`)

        // 1:1チャット画面にも履歴として残す。
        // chat_messages.sender は CHECK (sender IN ('user','admin')) のため 'admin' を使う。
        if (user) {
            const inserts = content.map((block) => ({
                channel_id: channelId,
                line_user_id: user.id,
                sender: 'admin',
                content_type: block.type,
                content: block,
                delivery_source: 'auto_reply',
            }))
            const { error: logError } = await supabase.from('chat_messages').insert(inserts)
            if (logError) {
                console.error('自動応答の履歴保存エラー:', logError)
            }
        }
    } catch (err) {
        // 応答に失敗しても友だち登録やチャット履歴の保存は続行させる
        console.error(`自動応答エラー (userId: ${lineUserId}):`, err)
    }
}

/**
 * メッセージイベント処理
 */
async function handleMessage(
    supabase: ReturnType<typeof createAdminClient>,
    lineClient: LineClient,
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

        // 画像・動画・音声・ファイルはWebhookに実体が入っていないので、
        // ここでLINEのコンテンツAPIから取得して保存する。
        // これをやらないと、LINE公式アカウントアプリでは見えているやり取りが
        // 管理画面の1:1チャットでは空の吹き出しになってしまう。
        const normalized = await normalizeIncomingMessage(lineClient, channelId, message)

        // メッセージを保存
        // line_message_id を入れておくことで、Webhookが再送されても二重登録されない
        // （channel_id + line_message_id にユニークインデックスあり）。
        const { error: msgError } = await supabase
            .from('chat_messages')
            .insert({
                channel_id: channelId,
                line_user_id: user.id,
                sender: 'user',
                content_type: normalized.contentType,
                content: normalized.content,
                line_message_id: message.id ?? null,
                delivery_source: 'line',
            })

        if (msgError) {
            // 一意制約違反（Webhook再送）は想定内なので、未読数を二重に増やさず終了する
            if (msgError.code === '23505') {
                console.log('受信済みのメッセージのためスキップ:', message.id)
                return
            }
            console.error('メッセージ保存エラー:', msgError)
            return
        }

        // ユーザー情報の更新（最終メッセージ日時、未読数）
        await supabase
            .from('line_users')
            .update({
                last_message_at: new Date().toISOString(),
                unread_count: (user.unread_count || 0) + 1,
                last_message_content: normalized.preview,
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
