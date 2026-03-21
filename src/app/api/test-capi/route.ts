import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

/**
 * テスト用エンドポイント: CAPI連携の診断
 * GET /api/test-capi?ch=CHANNEL_UUID&uid=LINE_USER_ID
 */
export async function GET(request: NextRequest) {
    const ch = request.nextUrl.searchParams.get('ch')
    const uid = request.nextUrl.searchParams.get('uid')

    if (!ch || !uid) {
        return NextResponse.json({ error: 'ch と uid パラメータが必要です' }, { status: 400 })
    }

    const results: Record<string, unknown> = {
        step1_env_check: {},
        step2_db_lookup: {},
        step3_status_update: {},
        step4_capi_call: {},
    }

    try {
        // STEP 1: 環境変数チェック
        const pixelId = process.env.META_PIXEL_ID
        const accessToken = process.env.META_ACCESS_TOKEN
        const testCode = process.env.META_TEST_EVENT_CODE
        results.step1_env_check = {
            META_PIXEL_ID: pixelId ? `設定済み (${pixelId.substring(0, 6)}...)` : '未設定',
            META_ACCESS_TOKEN: accessToken ? `設定済み (${accessToken.substring(0, 6)}...)` : '未設定',
            META_TEST_EVENT_CODE: testCode || '未設定',
        }

        // STEP 2: ad_conversions検索
        const supabase = createAdminClient()
        const { data: conversion, error: dbError } = await supabase
            .from('ad_conversions')
            .select('id, fbclid, status, channel_id, line_user_id, created_at')
            .eq('channel_id', ch)
            .eq('line_user_id', uid)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(1)
            .single()

        results.step2_db_lookup = {
            found: !!conversion,
            error: dbError?.message || null,
            record: conversion || null,
        }

        if (!conversion) {
            return NextResponse.json(results)
        }

        // STEP 3: ステータス更新テスト
        const { error: updateError } = await supabase
            .from('ad_conversions')
            .update({
                status: 'converted',
                converted_at: new Date().toISOString(),
            })
            .eq('id', conversion.id)

        results.step3_status_update = {
            success: !updateError,
            error: updateError?.message || null,
        }

        // STEP 4: Meta CAPI送信テスト
        if (pixelId && accessToken) {
            const eventTime = Math.floor(Date.now() / 1000)
            const fbcValue = conversion.fbclid
                ? `fb.1.${Date.now()}.${conversion.fbclid}`
                : undefined

            const payload: Record<string, unknown> = {
                data: [
                    {
                        event_name: 'Lead',
                        event_time: eventTime,
                        action_source: 'website',
                        user_data: {
                            ...(fbcValue ? { fbc: fbcValue } : {}),
                        },
                    },
                ],
            }

            if (testCode) {
                payload.test_event_code = testCode
            }

            const res = await fetch(
                `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                }
            )

            const responseText = await res.text()
            results.step4_capi_call = {
                status: res.status,
                ok: res.ok,
                response: responseText,
            }
        } else {
            results.step4_capi_call = { skipped: '環境変数未設定のためスキップ' }
        }

    } catch (error) {
        results.unexpected_error = String(error)
    }

    return NextResponse.json(results, { status: 200 })
}
