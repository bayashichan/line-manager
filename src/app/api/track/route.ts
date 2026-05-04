import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

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
        const { error } = await supabase.from('ad_conversions').insert({
            channel_id,
            line_user_id,
            fbclid: fbclid ?? null,
            fbp: fbp ?? null,
            tag: tag ?? null,
            user_agent: user_agent ?? null,
            event_source_url: event_source_url ?? null,
            client_ip: clientIp,
        })

        if (error) {
            console.error('ad_conversions 保存エラー:', error)
            return NextResponse.json({ error: '保存に失敗しました' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('トラッキングAPIエラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
