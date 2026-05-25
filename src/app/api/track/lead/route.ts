import { NextRequest, NextResponse } from 'next/server'

/**
 * LP の友だち追加ボタン押下時 = Lead イベント送信エンドポイント
 * POST /api/track/lead
 *
 * 設計意図:
 * - 友だち追加の完了 (CompleteRegistration) は LIFF → webhook 経由で計測しているが、
 *   iPhone (FBIOS) では fbp/fbc/event_source_url/client_ip が分断され Meta 側でマッチング不能。
 * - そこで「LP のボタンを押した = 登録意思を示した」時点を Lead として Meta に送り、
 *   最適化シグナルを稼ぐ。LP ドメイン内で完結するため UA/IP/fbp/fbc/event_source_url が
 *   すべて揃った状態で発火できる。
 * - Browser Pixel 側でも同じ event_id で fbq('track', 'Lead', ..., {eventID}) を発火し、
 *   CAPI と Browser を Meta 側で deduplication させる (EMQ 最大化)。
 *
 * LP からの呼び出しは異なるドメイン (updatehayashi.jp) からの cross-origin POST のため、
 * 明示的に CORS ヘッダを返す。
 */

const ALLOWED_ORIGINS = new Set([
    'https://updatehayashi.jp',
    'https://www.updatehayashi.jp',
    'https://bayashichan.github.io',
])

function buildCorsHeaders(origin: string | null): Record<string, string> {
    const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://updatehayashi.jp'
    return {
        'Access-Control-Allow-Origin': allowed,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    }
}

export async function OPTIONS(request: NextRequest) {
    return new NextResponse(null, {
        status: 204,
        headers: buildCorsHeaders(request.headers.get('origin')),
    })
}

export async function POST(request: NextRequest) {
    const cors = buildCorsHeaders(request.headers.get('origin'))

    try {
        // sendBeacon は Content-Type を自由に設定できないため text → JSON.parse でフォールバック
        let body: Record<string, unknown> = {}
        const raw = await request.text()
        if (raw) {
            try {
                body = JSON.parse(raw)
            } catch {
                return NextResponse.json({ error: '不正な JSON' }, { status: 400, headers: cors })
            }
        }

        const event_id = typeof body.event_id === 'string' ? body.event_id : null
        const fbclid = typeof body.fbclid === 'string' && body.fbclid ? body.fbclid : null
        const fbp = typeof body.fbp === 'string' && body.fbp ? body.fbp : null
        const fbcInput = typeof body.fbc === 'string' && body.fbc ? body.fbc : null
        const user_agent = typeof body.user_agent === 'string' && body.user_agent ? body.user_agent : null
        const event_source_url = typeof body.event_source_url === 'string' && body.event_source_url
            ? body.event_source_url
            : null

        if (!event_id) {
            return NextResponse.json({ error: 'event_id は必須です' }, { status: 400, headers: cors })
        }

        const pixelId = process.env.META_PIXEL_ID
        const accessToken = process.env.META_ACCESS_TOKEN
        if (!pixelId || !accessToken) {
            console.warn('Meta CAPI環境変数未設定 (META_PIXEL_ID / META_ACCESS_TOKEN)')
            return NextResponse.json({ success: false, reason: 'env_missing' }, { status: 200, headers: cors })
        }

        const xForwardedFor = request.headers.get('x-forwarded-for')
        const clientIp = xForwardedFor
            ? xForwardedFor.split(',')[0].trim()
            : request.headers.get('x-real-ip')

        // fbc は LP が cookie から渡してきたものを最優先、無ければ fbclid から組み立て
        let fbc = fbcInput
        if (!fbc && fbclid) {
            fbc = `fb.1.${Date.now()}.${fbclid}`
        }

        const payload: Record<string, unknown> = {
            data: [
                {
                    event_name: 'Lead',
                    event_time: Math.floor(Date.now() / 1000),
                    event_id,
                    action_source: 'website',
                    event_source_url: event_source_url ?? undefined,
                    user_data: {
                        ...(fbc ? { fbc } : {}),
                        ...(fbp ? { fbp } : {}),
                        ...(clientIp ? { client_ip_address: clientIp } : {}),
                        ...(user_agent ? { client_user_agent: user_agent } : {}),
                    },
                },
            ],
        }

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

        if (!res.ok) {
            const errText = await res.text()
            console.error('Meta CAPI Lead 送信エラー:', errText)
            return NextResponse.json(
                { success: false, error: errText },
                { status: 200, headers: cors }
            )
        }

        console.log(`Meta CAPI Lead 送信成功 (event_id: ${event_id}, fbclid: ${fbclid ?? 'なし'})`)
        return NextResponse.json({ success: true, event_id }, { status: 200, headers: cors })
    } catch (error) {
        console.error('Lead トラッキングAPIエラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500, headers: cors }
        )
    }
}
