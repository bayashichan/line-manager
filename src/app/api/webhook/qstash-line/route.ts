import { NextRequest, NextResponse } from 'next/server'
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { chunk } from '@/lib/utils'

/**
 * QStashからのWebhook受信エンドポイント (予約配信の実行)
 * POST /api/webhook/qstash-line
 */
async function handler(request: NextRequest) {
    try {
        const body = await request.json()
        const { messageId } = body

        if (!messageId) {
            console.error('QStash Webhook Error: messageId がありません')
            return NextResponse.json({ error: 'messageId missing' }, { status: 400 })
        }

        const adminClient = createAdminClient()

        // 1. メッセージ情報の取得
        const { data: message, error: messageError } = await adminClient
            .from('messages')
            .select(`*, channels (*)`)
            .eq('id', messageId)
            .single()

        if (messageError || !message) {
            console.error('QStash Webhook Error: メッセージが見つかりません', messageId)
            return NextResponse.json({ error: 'Message not found' }, { status: 404 })
        }

        // 既に送信済み/処理中の場合はスキップ
        if (message.status === 'sent' || message.status === 'sending') {
            console.log(`QStash Webhook: メッセージ ${messageId} は既に処理されています。ステータス: ${message.status}`)
            return NextResponse.json({ success: true, skipped: true })
        }

        // ステータスを送信中に更新
        await adminClient
            .from('messages')
            .update({ status: 'sending' })
            .eq('id', messageId)


        // 2. 配信対象ユーザーの取得
        let query = adminClient
            .from('line_users')
            .select('id, line_user_id')
            .eq('channel_id', message.channel_id)
            .eq('is_blocked', false)

        // 絞り込み (フィルタータグ)
        if (message.filter_tags && message.filter_tags.length > 0) {
            const { data: filteredUsers } = await adminClient
                .from('line_user_tags')
                .select('line_user_id')
                .in('tag_id', message.filter_tags)

            if (filteredUsers && filteredUsers.length > 0) {
                const userIds = [...new Set(filteredUsers.map(u => u.line_user_id))]
                query = query.in('id', userIds)
            } else {
                // 該当者なし
                await completeMessage(adminClient, messageId, 0, 0, 0)
                return NextResponse.json({ success: true, sent: 0 })
            }
        }

        // 除外 (除外タグ)
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
            await completeMessage(adminClient, messageId, 0, 0, 0)
            return NextResponse.json({ success: true, sent: 0 })
        }


        // 3. LINE APIで送信
        const channel = message.channels as any
        const lineClient = new LineClient(channel.channel_access_token)

        const lineUserIds = recipients.map(r => r.line_user_id)
        const batches = chunk(lineUserIds, 500)

        let successCount = 0
        let failureCount = 0

        // コンテンツの変換
        const processedContent = (message.content as any[]).map((block: any) => {
            if (block.type === 'image' && (block.customActions || block.linkUrl)) {
                let action: any

                if (block.customActions) {
                    if (block.customActions.redirectUrl) {
                        action = { type: 'uri', uri: block.customActions.redirectUrl }
                    } else {
                        action = { type: 'postback', data: `action=custom&mid=${messageId}` }
                    }
                } else if (block.linkUrl) {
                    action = { type: 'uri', uri: block.linkUrl }
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

        // {name} プレースホルダーの存在確認
        const hasNamePlaceholder = processedContent.some((block: any) =>
            (block.type === 'text' && block.text?.includes('{name}'))
        )

        if (hasNamePlaceholder) {
            // 個別送信モード
            const { data: usersWithProfile } = await adminClient
                .from('line_users')
                .select('line_user_id, display_name')
                .in('line_user_id', lineUserIds)

            const userMap = new Map(usersWithProfile?.map(u => [u.line_user_id, u.display_name]) || [])
            const pushBatches = chunk(lineUserIds, 10)

            for (const batch of pushBatches) {
                await Promise.all(batch.map(async (userId) => {
                    try {
                        const displayName = userMap.get(userId) || '友だち'
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
                    } catch (error) {
                        console.error(`個別送信エラー (${userId}):`, error)
                        failureCount++
                    }
                }))
            }
        } else {
            // 一斉送信モード
            for (const batch of batches) {
                try {
                    await lineClient.multicast(batch, processedContent)
                    successCount += batch.length
                } catch (error) {
                    console.error('配信エラー:', error)
                    failureCount += batch.length
                }
            }
        }

        // 4. ステータス更新と完了
        await completeMessage(adminClient, messageId, recipients.length, successCount, failureCount)

        return NextResponse.json({ success: true, successCount, failureCount })

    } catch (error: any) {
        console.error('QStash Webhook 処理エラー:', error)
        return NextResponse.json({ error: error?.message || 'Internal Server Error' }, { status: 500 })
    }
}

// 完了時のDB更新ヘルパー
async function completeMessage(adminClient: any, messageId: string, total: number, success: number, failure: number) {
    await adminClient
        .from('messages')
        .update({
            status: 'sent',
            total_recipients: total,
            success_count: success,
            failure_count: failure,
            sent_at: new Date().toISOString(),
        })
        .eq('id', messageId)
}

// Upstash QStash の署名検証ミドルウェアでラップ
export const POST = verifySignatureAppRouter(handler)
