import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams
    const mid = searchParams.get('mid') // Message ID
    const uid = searchParams.get('uid') // Line User ID
    const signature = searchParams.get('sig')

    if (!mid || !uid) {
        return new NextResponse('Invalid parameters', { status: 400 })
    }

    const supabase = createAdminClient()

    try {
        // メッセージ取得
        const { data: message } = await supabase
            .from('messages')
            .select('channel_id, content')
            .eq('id', mid)
            .single()

        if (!message) {
            return new NextResponse('Message not found', { status: 404 })
        }

        // リッチメッセージ（画像メッセージ）を探す
        // 簡易的に最初の画像メッセージのカスタムアクションを使用する
        const imageContent = (message.content as any[]).find(c => c.type === 'image')
        const actions = imageContent?.customActions

        if (!actions) {
            return new NextResponse('No actions found', { status: 404 })
        }

        // チャンネル情報など取得（LINEクライアント作成用）
        const { data: channel } = await supabase
            .from('channels')
            .select('*')
            .eq('channel_id', message.channel_id)
            .single()

        if (!channel) {
            return new NextResponse('Channel not found', { status: 404 })
        }

        const lineClient = new LineClient(channel.channel_access_token)

        // ユーザーID解決 (uidはLINEのuserId)
        const { data: user } = await supabase
            .from('line_users')
            .select('id')
            .eq('channel_id', message.channel_id)
            .eq('line_user_id', uid)
            .single()

        if (user) {
            // 1. タグ付け
            if (actions.tagIds && actions.tagIds.length > 0) {
                const tagInserts = actions.tagIds.map((tagId: string) => ({
                    line_user_id: user.id,
                    tag_id: tagId
                }))
                // 重複無視で挿入
                await supabase.from('line_user_tags').upsert(tagInserts, { onConflict: 'line_user_id,tag_id' })
            }

            // 2. ステップ配信（シナリオ）開始
            if (actions.scenarioId) {
                // シナリオ詳細取得
                const { data: scenario } = await supabase
                    .from('step_scenarios')
                    .select('*, step_messages(*)')
                    .eq('id', actions.scenarioId)
                    .single()

                if (scenario && scenario.step_messages.length > 0) {
                    // 既存の進行中ステップを停止できるなら停止する処理がいりそうだが、
                    // 今回は新規開始のみ実装
                    const firstMsg = scenario.step_messages.sort((a: any, b: any) => a.step_order - b.step_order)[0]
                    const delayMinutes = firstMsg.delay_minutes
                    const nextSendAt = new Date(Date.now() + delayMinutes * 60000).toISOString()

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
                await lineClient.pushMessage(uid, [{ type: 'text', text: actions.replyText }])
            }
        }

        // 4. リダイレクト
        if (actions.redirectUrl) {
            return NextResponse.redirect(actions.redirectUrl)
        }

        return new NextResponse('Action completed', { status: 200 })

    } catch (error) {
        console.error('Redirect action error:', error)
        return new NextResponse('Internal Server Error', { status: 500 })
    }
}
