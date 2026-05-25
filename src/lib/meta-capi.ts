import { createHash } from 'crypto'
import type { createAdminClient } from '@/lib/supabase/server'

type AdminClient = ReturnType<typeof createAdminClient>

interface ConversionRow {
    id: string
    fbclid: string | null
    fbp: string | null
    fbc: string | null
    click_time_ms: number | null
    user_agent: string | null
    client_ip: string | null
    event_source_url: string | null
    status: string
}

/**
 * fbc を構築する。
 * 優先順位:
 *   1. LP/クライアント由来で保存済みの fbc (最も正確)
 *   2. サーバが INSERT 時に記録した click_time_ms + fbclid
 *   3. (旧データ互換) fbp に埋め込まれたタイムスタンプ + fbclid
 */
function buildFbc(conversion: ConversionRow): string | undefined {
    if (conversion.fbc) return conversion.fbc

    if (!conversion.fbclid) return undefined

    if (conversion.click_time_ms) {
        return `fb.1.${conversion.click_time_ms}.${conversion.fbclid}`
    }

    const fbpTimestampStr = conversion.fbp?.split('.')[2]
    const fbpTimestamp = fbpTimestampStr ? parseInt(fbpTimestampStr, 10) : NaN
    if (!isNaN(fbpTimestamp)) {
        return `fb.1.${fbpTimestamp}.${conversion.fbclid}`
    }
    return undefined
}

/**
 * 同一 (channelId, lineUserId, eventName) の送信が
 * Meta 側で確実に重複排除されるよう deterministic な event_id を生成。
 * Meta CAPI の dedup window は 7 日。
 */
export function buildMetaEventId(channelId: string, lineUserId: string, eventName = 'CompleteRegistration'): string {
    return createHash('sha256')
        .update(`${channelId}:${lineUserId}:${eventName}`)
        .digest('hex')
        .slice(0, 32)
}

export type SendMetaCapiResult =
    | { status: 'sent'; metaEventId: string }
    | { status: 'no_pending' }
    | { status: 'env_missing' }
    | { status: 'api_error'; message: string }

/**
 * Meta Conversions API へ友だち追加完了イベント (デフォルト: CompleteRegistration) を送信する。
 *
 * イベント名の使い分け:
 *   - CompleteRegistration (デフォルト): LINE 友だち追加が確定した時点 (= 実登録) を表す。
 *   - Lead: LP のボタン押下時など、登録意思を示した時点を表す。こちらは
 *     `src/app/api/track/lead/route.ts` で直接 Meta に送る。
 *
 * - ad_conversions の pending 行が存在する場合のみ送信する。
 * - 送信成功/失敗にかかわらず status を converted に進める（再試行は Meta 側の dedup に委ねる）。
 * - event_id は (channelId, lineUserId, eventName) から deterministic に生成し、
 *   リトライや track-after-follow 救済経路で重複発火しても Meta 側で必ず dedup される。
 * - `eventTimeSeconds` を指定するとイベント時刻を上書きできる（バックフィルで followed_at を使う用途）。
 */
export async function sendMetaCapiEvent(
    supabase: AdminClient,
    channelId: string,
    lineUserId: string,
    options?: { eventTimeSeconds?: number; eventName?: string }
): Promise<SendMetaCapiResult> {
    const pixelId = process.env.META_PIXEL_ID
    const accessToken = process.env.META_ACCESS_TOKEN
    if (!pixelId || !accessToken) {
        console.warn('Meta CAPI環境変数未設定 (META_PIXEL_ID / META_ACCESS_TOKEN)')
        return { status: 'env_missing' }
    }

    const eventName = options?.eventName ?? 'CompleteRegistration'

    const { data: conversion } = await supabase
        .from('ad_conversions')
        .select('id, fbclid, fbp, fbc, click_time_ms, user_agent, client_ip, event_source_url, status')
        .eq('channel_id', channelId)
        .eq('line_user_id', lineUserId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (!conversion) {
        // 広告経由ではない友だち追加 (正常パス)、または既に converted 済み
        return { status: 'no_pending' }
    }

    const row = conversion as ConversionRow
    const eventTime = options?.eventTimeSeconds ?? Math.floor(Date.now() / 1000)
    const fbcValue = buildFbc(row)
    const hashedExternalId = createHash('sha256').update(lineUserId).digest('hex')
    const metaEventId = buildMetaEventId(channelId, lineUserId, eventName)

    const payload: Record<string, unknown> = {
        data: [
            {
                event_name: eventName,
                event_time: eventTime,
                event_id: metaEventId,
                action_source: 'website',
                event_source_url: row.event_source_url || undefined,
                user_data: {
                    ...(fbcValue ? { fbc: fbcValue } : {}),
                    ...(row.fbp ? { fbp: row.fbp } : {}),
                    ...(row.client_ip ? { client_ip_address: row.client_ip } : {}),
                    external_id: hashedExternalId,
                    client_user_agent: row.user_agent || undefined,
                },
            },
        ],
    }

    if (process.env.META_TEST_EVENT_CODE) {
        payload.test_event_code = process.env.META_TEST_EVENT_CODE
    }

    // 先に status を進めることで、後続の重複呼び出しがこの行を pending として再取得しないようにする
    await supabase
        .from('ad_conversions')
        .update({
            status: 'converted',
            converted_at: new Date().toISOString(),
            meta_event_id: metaEventId,
        })
        .eq('id', row.id)

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
        console.error(`Meta CAPI APIエラー (userId: ${lineUserId}):`, errText)
        return { status: 'api_error', message: errText }
    }

    console.log(`Meta CAPI送信成功 [${eventName}] (userId: ${lineUserId}, fbclid: ${row.fbclid ?? 'なし'})`)
    return { status: 'sent', metaEventId }
}
