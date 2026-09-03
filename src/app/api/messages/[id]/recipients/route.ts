import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * 配信の友だちごとの到達・既読状況
 * GET /api/messages/[id]/recipients?status=all|read|unread|failed&limit=100&offset=0
 *
 * 【既読の意味】
 * LINE Messaging API は既読を通知しないため、ここで返す read_at は「みなし既読」。
 * 配信後に友だちから反応（返信・ボタンタップ・リンクタップ）があった時点で既読としている。
 * 反応が無い＝読んでいない、とは限らない点に注意（未読は「確認できていない」の意味）。
 */

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

type RecipientStatus = 'all' | 'read' | 'unread' | 'failed'

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id: messageId } = await params
        const { searchParams } = new URL(request.url)
        const status = (searchParams.get('status') || 'all') as RecipientStatus
        const limit = Math.min(
            Number(searchParams.get('limit')) || DEFAULT_LIMIT,
            MAX_LIMIT
        )
        const offset = Number(searchParams.get('offset')) || 0

        // RLSの効く通常クライアントを使う。
        // message_recipients / line_users はチャンネルのメンバーだけが読める設定なので、
        // ここで権限チェックを二重に書かなくても他人の配信は見えない。
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const { data: message, error: messageError } = await supabase
            .from('messages')
            .select('id, title, sent_at, total_recipients, success_count, failure_count')
            .eq('id', messageId)
            .maybeSingle()

        if (messageError) {
            console.error('配信取得エラー:', messageError)
            return NextResponse.json({ error: '配信の取得に失敗しました' }, { status: 500 })
        }
        if (!message) {
            return NextResponse.json({ error: '配信が見つかりません' }, { status: 404 })
        }

        // 集計（件数は行を全部取らずにcountだけ取る）
        const counts = await fetchCounts(supabase, messageId)

        let query = supabase
            .from('message_recipients')
            .select(
                'id, status, error_message, sent_at, read_at, read_source, line_users(id, display_name, internal_name, picture_url)'
            )
            .eq('message_id', messageId)

        if (status === 'read') {
            query = query.not('read_at', 'is', null)
        } else if (status === 'unread') {
            query = query.eq('status', 'sent').is('read_at', null)
        } else if (status === 'failed') {
            query = query.eq('status', 'failed')
        }

        // 既読が新しい順 → 未読はまとめて後ろ、という並びにする
        const { data: recipients, error: recipientsError } = await query
            .order('read_at', { ascending: false, nullsFirst: false })
            .order('id', { ascending: true })
            .range(offset, offset + limit - 1)

        if (recipientsError) {
            console.error('配信対象の取得エラー:', recipientsError)
            return NextResponse.json({ error: '配信対象の取得に失敗しました' }, { status: 500 })
        }

        return NextResponse.json({
            message,
            counts,
            recipients: recipients ?? [],
            // 配信対象の記録は今回の機能から始まったので、過去の配信には行が無い
            hasTracking: counts.total > 0,
            hasMore: (recipients?.length ?? 0) === limit,
        })
    } catch (error) {
        console.error('既読状況APIエラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}

async function fetchCounts(
    supabase: Awaited<ReturnType<typeof createClient>>,
    messageId: string
) {
    const base = () =>
        supabase
            .from('message_recipients')
            .select('id', { count: 'exact', head: true })
            .eq('message_id', messageId)

    const unwrap = ({ count, error }: { count: number | null; error: unknown }) => {
        if (error) {
            console.error('件数集計エラー:', error)
            return 0
        }
        return count ?? 0
    }

    const [total, sent, failed, read] = await Promise.all([
        base().then(unwrap),
        base().eq('status', 'sent').then(unwrap),
        base().eq('status', 'failed').then(unwrap),
        base().not('read_at', 'is', null).then(unwrap),
    ])

    return {
        total,
        sent,
        failed,
        read,
        // 届いたが反応が確認できていない人
        unread: Math.max(sent - read, 0),
    }
}
