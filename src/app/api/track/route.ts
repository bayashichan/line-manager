import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { sendMetaCapiEvent } from '@/lib/meta-capi'

const ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

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
        const { channel_id, line_user_id, fbclid, fbp, fbc, tag, user_agent, event_source_url } = body

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

        // dedup: 直近 7 日以内の同一 (channel_id, line_user_id) を status 不問で検索
        //   - converted があれば既に Lead 計上済み → 何もせず終了
        //   - pending があれば UPDATE で最新メタ情報に差し替え
        //   - 行なし or 7 日より古い → 新規 INSERT
        const since = new Date(Date.now() - ATTRIBUTION_WINDOW_MS).toISOString()
        const { data: recent } = await supabase
            .from('ad_conversions')
            .select('id, status')
            .eq('channel_id', channel_id)
            .eq('line_user_id', line_user_id)
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

        if (recent?.status === 'converted') {
            return NextResponse.json({ success: true, deduped: true })
        }

        const clickTimeMs = Date.now()
        const resolvedFbc = fbc ?? (fbclid ? `fb.1.${clickTimeMs}.${fbclid}` : null)

        const payload = {
            fbclid: fbclid ?? null,
            fbp: fbp ?? null,
            fbc: resolvedFbc,
            tag: tag ?? null,
            user_agent: user_agent ?? null,
            event_source_url: event_source_url ?? null,
            client_ip: clientIp,
        }

        if (recent?.status === 'pending') {
            const { error } = await supabase
                .from('ad_conversions')
                .update(payload)
                .eq('id', recent.id)
            if (error) {
                console.error('ad_conversions UPDATE エラー:', error)
                return NextResponse.json({ error: '保存に失敗しました' }, { status: 500 })
            }
        } else {
            const { error } = await supabase
                .from('ad_conversions')
                .insert({
                    channel_id,
                    line_user_id,
                    click_time_ms: clickTimeMs,
                    ...payload,
                })
            if (error) {
                console.error('ad_conversions INSERT エラー:', error)
                return NextResponse.json({ error: '保存に失敗しました' }, { status: 500 })
            }
        }

        // track-after-follow 救済:
        // webhook が /api/track より先に到達したケース、または広告連携前から既に
        // 友だちだったユーザーが広告経由で再訪したケースでは、follow webhook では
        // pending 行がまだ無く CAPI 発火できていない。
        // ここで followed_at が既にセットされていることを検出したら、その場で CAPI を送信する。
        const { data: lineUser } = await supabase
            .from('line_users')
            .select('followed_at, is_blocked')
            .eq('channel_id', channel_id)
            .eq('line_user_id', line_user_id)
            .maybeSingle()

        if (lineUser?.followed_at && !lineUser.is_blocked) {
            try {
                await sendMetaCapiEvent(supabase, channel_id, line_user_id)
            } catch (err) {
                console.error(`track-after-follow CAPI 送信エラー (userId: ${line_user_id}):`, err)
            }
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('トラッキングAPIエラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
