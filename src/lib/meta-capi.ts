import { createHash } from 'crypto'
import { createAdminClient } from '@/lib/supabase/server'

/**
 * Meta Conversions API へ Lead イベントを送信する。
 * ad_conversions テーブルの pending レコードを検索し、found なら CAPI 送信 → converted に更新。
 */
export async function sendMetaCapiEvent(
    supabase: ReturnType<typeof createAdminClient>,
    channelId: string,
    lineUserId: string
) {
    const pixelId = process.env.META_PIXEL_ID
    const accessToken = process.env.META_ACCESS_TOKEN
    if (!pixelId || !accessToken) {
        console.warn('Meta CAPI環境変数未設定 (META_PIXEL_ID / META_ACCESS_TOKEN)')
        return
    }

    const { data: conversion } = await supabase
        .from('ad_conversions')
        .select('id, fbclid, fbp, user_agent, client_ip, event_source_url')
        .eq('channel_id', channelId)
        .eq('line_user_id', lineUserId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

    if (!conversion) {
        // 広告経由以外の友だち追加（正常）
        return
    }

    const eventTime = Math.floor(Date.now() / 1000)
    // fbc は LP のクリック時刻ベースで構築する (Date.now() だと EMQ が下がる)。
    // _fbp クッキーが `fb.1.<click_timestamp_ms>.<value>` 形式で同じクリック時刻を持つため、
    // そこからタイムスタンプを抽出して fbc を構築する。
    const fbpTimestampStr = conversion.fbp?.split('.')[2]
    const fbpTimestamp = fbpTimestampStr ? parseInt(fbpTimestampStr, 10) : NaN
    const fbcValue = conversion.fbclid && !isNaN(fbpTimestamp)
        ? `fb.1.${fbpTimestamp}.${conversion.fbclid}`
        : undefined

    const hashedExternalId = createHash('sha256').update(lineUserId).digest('hex')

    const payload: Record<string, unknown> = {
        data: [
            {
                event_name: 'Lead',
                event_time: eventTime,
                event_id: conversion.id,
                action_source: 'website',
                event_source_url: conversion.event_source_url || undefined,
                user_data: {
                    ...(fbcValue ? { fbc: fbcValue } : {}),
                    ...(conversion.fbp ? { fbp: conversion.fbp } : {}),
                    ...(conversion.client_ip ? { client_ip_address: conversion.client_ip } : {}),
                    external_id: hashedExternalId,
                    client_user_agent: conversion.user_agent || undefined,
                },
            },
        ],
    }

    if (process.env.META_TEST_EVENT_CODE) {
        payload.test_event_code = process.env.META_TEST_EVENT_CODE
    }

    // statusを先に更新（Webhook到達確認のため）
    await supabase
        .from('ad_conversions')
        .update({
            status: 'converted',
            converted_at: new Date().toISOString(),
        })
        .eq('id', conversion.id)

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
        return
    }

    console.log(`Meta CAPI送信成功 (userId: ${lineUserId}, fbclid: ${conversion.fbclid ?? 'なし'})`)
}
