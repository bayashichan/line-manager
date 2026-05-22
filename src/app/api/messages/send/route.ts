import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { chunk } from '@/lib/utils'

/**
 * メッセージ送信
 * POST /api/messages/send
 */
export async function POST(request: NextRequest) {
    let messageId: string | undefined
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const body = await request.json()
        messageId = body.messageId

        if (!messageId) {
            return NextResponse.json({ error: 'messageId が必要です' }, { status: 400 })
        }

        // メッセージ情報取得
        const adminClient = createAdminClient()
        const { data: message, error: messageError } = await adminClient
            .from('messages')
            .select(`
        *,
        channels (*)
      `)
            .eq('id', messageId)
            .single()

        if (messageError || !message) {
            return NextResponse.json({ error: 'メッセージが見つかりません' }, { status: 404 })
        }

        // 配信対象ユーザーを取得
        let query = adminClient
            .from('line_users')
            .select('id, line_user_id')
            .eq('channel_id', message.channel_id)
            .eq('is_blocked', false)

        // タグフィルターがある場合
        if (message.filter_tags && message.filter_tags.length > 0) {
            const { data: filteredUsers } = await adminClient
                .from('line_user_tags')
                .select('line_user_id')
                .in('tag_id', message.filter_tags)

            if (filteredUsers && filteredUsers.length > 0) {
                const userIds = [...new Set(filteredUsers.map(u => u.line_user_id))]
                query = query.in('id', userIds)
            } else {
                await adminClient
                    .from('messages')
                    .update({
                        status: 'sent',
                        total_recipients: 0,
                        success_count: 0,
                        failure_count: 0,
                        sent_at: new Date().toISOString(),
                    })
                    .eq('id', messageId)
                return NextResponse.json({ success: true, sent: 0 })
            }
        }

        // タグ除外がある場合
        if (message.exclude_tags && message.exclude_tags.length > 0) {
            const { data: excludedUsers } = await adminClient
                .from('line_user_tags')
                .select('line_user_id')
                .in('tag_id', message.exclude_tags)

            if (excludedUsers && excludedUsers.length > 0) {
                const excludedUserIds = [...new Set(excludedUsers.map(u => u.line_user_id))]
                query = query.not('id', 'in', `(${excludedUserIds.join(',')})`)
            }
        }

        const { data: recipients } = await query

        if (!recipients || recipients.length === 0) {
            await adminClient
                .from('messages')
                .update({
                    status: 'sent',
                    total_recipients: 0,
                    success_count: 0,
                    failure_count: 0,
                    sent_at: new Date().toISOString(),
                })
                .eq('id', messageId)

            return NextResponse.json({ success: true, sent: 0 })
        }

        // LINE クライアント作成
        const channel = message.channels as any
        const lineClient = new LineClient(channel.channel_access_token)

        // メッセージ送信（500人ずつバッチ処理）
        const lineUserIds = recipients.map(r => r.line_user_id)
        const batches = chunk(lineUserIds, 500)

        let successCount = 0
        let failureCount = 0
        let firstError: string | null = null

        // コンテンツの変換（リッチメッセージをFlex Messageに変換）
        const processedContent = (message.content as any[]).map((block: any) => {
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
                        // redirectUrlがない場合はPostback (タグ付け、シナリオなどはPostbackイベントで処理)
                        action = {
                            type: 'postback',
                            data: `action=custom&mid=${messageId}`
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

        // {name}プレースホルダーが含まれているかチェック
        const hasNamePlaceholder = processedContent.some((block: any) =>
            (block.type === 'text' && block.text?.includes('{name}'))
            // Flex Message (リッチメッセージ) の中身までは再帰的にチェックしていませんが、現状の構成ならtextブロックが主
        )

        if (hasNamePlaceholder) {
            // 個別送信モード（プッシュメッセージ）
            // 名前を取得するために再度クエリを実行（recipientsにはid, line_user_idしか含まれていない可能性があるため）
            // ※ 元のクエリでdisplay_nameも取得していれば再クエリ不要だが、念のため安全策
            const { data: usersWithProfile } = await adminClient
                .from('line_users')
                .select('line_user_id, display_name')
                .in('line_user_id', lineUserIds)

            const userMap = new Map(usersWithProfile?.map(u => [u.line_user_id, u.display_name]) || [])

            // 10件ずつの並列処理で送信（レートリミット対策）
            const pushBatches = chunk(lineUserIds, 10)

            for (const batch of pushBatches) {
                await Promise.all(batch.map(async (userId) => {
                    try {
                        const displayName = userMap.get(userId) || '友だち'

                        // コンテンツ内の{name}を置換
                        const personalizedContent = processedContent.map((block: any) => {
                            if (block.type === 'text') {
                                return {
                                    ...block,
                                    text: block.text.replace(/{name}/g, displayName)
                                }
                            }
                            return block
                        })

                        await lineClient.pushMessage(userId, personalizedContent)
                        successCount++
                    } catch (error: any) {
                        console.error(`個別送信エラー (${userId}):`, error)
                        failureCount++
                        if (!firstError) firstError = error?.message ?? String(error)
                    }
                }))
            }
        } else {
            // 通常の一斉送信モード（マルチキャスト）
            for (const batch of batches) {
                try {
                    await lineClient.multicast(batch, processedContent)
                    successCount += batch.length
                } catch (error: any) {
                    console.error('配信エラー:', error)
                    failureCount += batch.length
                    if (!firstError) firstError = error?.message ?? String(error)
                }
            }
        }

        // ステータス更新
        await adminClient
            .from('messages')
            .update({
                status: failureCount === recipients.length ? 'failed' : 'sent',
                total_recipients: recipients.length,
                success_count: successCount,
                failure_count: failureCount,
                error_detail: failureCount > 0 ? firstError : null,
                sent_at: new Date().toISOString(),
            })
            .eq('id', messageId)

        return NextResponse.json({
            success: true,
            total: recipients.length,
            successCount,
            failureCount,
        })
    } catch (error) {
        console.error('メッセージ送信エラー:', error)
        if (messageId) {
            try {
                const adminClient = createAdminClient()
                await adminClient
                    .from('messages')
                    .update({
                        status: 'failed',
                        sent_at: new Date().toISOString(),
                    })
                    .eq('id', messageId)
            } catch (updateError) {
                console.error('ステータス更新失敗:', updateError)
            }
        }
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
