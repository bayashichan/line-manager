import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { sendMetaCapiEvent } from '@/lib/meta-capi'

/**
 * 広告コンバージョントラッキング
 * POST /api/track
 *
 * LIFFページからPOSTされ、サーバー側でクライアントIPを取得してad_conversionsに保存する。
 * Supabaseに直接POSTする方式ではIPが取れないため、このルートを経由する。
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const { channel_id, line_user_id, fbclid, fbp, tag, user_agent, event_source_url } = body

        if (!channel_id || !line_user_id) {
            return NextResponse.json({ error: 'channel_id と line_user_id は必須です' }, { status: 400 })
        }

        // クライアントIPをリクエストヘッダーから取得
        // Vercel / CDN 環境では x-forwarded-for が実際のクライアントIPを保持する
        const xForwardedFor = request.headers.get('x-forwarded-for')
        const clientIp = xForwardedFor
            ? xForwardedFor.split(',')[0].trim()
            : request.headers.get('x-real-ip') ?? null

        const supabase = createAdminClient()

        // 直近の重複レコードを排除する。
        // - pending があれば UPDATE
        // - 30 分以内に converted されたレコードがあれば、ユーザーが LIFF を再訪しても新規 INSERT せずに無視
        //   （Webhook が既に CAPI を発火済みなので、新規 pending を作ると永久にコンバージョンしない孤児が残る）
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
        const { data: recent } = await supabase
            .from('ad_conversions')
            .select('id, status')
            .eq('channel_id', channel_id)
            .eq('line_user_id', line_user_id)
            .gte('created_at', thirtyMinutesAgo)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

        const payload = {
            fbclid: fbclid ?? null,
            fbp: fbp ?? null,
            tag: tag ?? null,
            user_agent: user_agent ?? null,
            event_source_url: event_source_url ?? null,
            client_ip: clientIp,
        }

        if (recent?.status === 'converted') {
            // 30 分以内に CAPI 発火済み。重複作成を防ぐためここで終了。
            return NextResponse.json({ success: true, deduplicated: true })
        }

        const { error } = recent?.status === 'pending'
            ? await supabase.from('ad_conversions').update(payload).eq('id', recent.id)
            : await supabase.from('ad_conversions').insert({ channel_id, line_user_id, ...payload })

        if (error) {
            console.error('ad_conversions 保存エラー:', error)
            return NextResponse.json({ error: '保存に失敗しました' }, { status: 500 })
        }

        // レースコンディション対応: LINEのWebhookがLIFF /api/track より先に到達した場合、
        // Webhookはpendingレコードを見つけられずにCAPIをスキップする。
        // そのためtracking保存後にline_usersのfollowed_atを確認し、
        // Webhookが先に処理済みであれば今すぐCAPIを送信する。
        if (line_user_id && channel_id) {
            const { data: lineUser } = await supabase
                .from('line_users')
                .select('followed_at')
                .eq('channel_id', channel_id)
                .eq('line_user_id', line_user_id)
                .not('followed_at', 'is', null)
                .maybeSingle()

            if (lineUser) {
                await sendMetaCapiEvent(supabase, channel_id, line_user_id)
                    .catch(err => console.error('CAPI送信エラー (race condition fix):', err))
            }
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('トラッキングAPIエラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
