import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { sendMetaCapiEvent } from '@/lib/meta-capi'

/**
 * Meta CAPI バックフィル (ワンショット管理用エンドポイント)
 * POST /api/admin/backfill-capi
 *
 * 過去に webhook が pending を取りこぼした / iPhone 経由で Ads Manager 未計上だった
 * 友だち追加について、`line_users.followed_at` をイベント時刻として CAPI を再送信する。
 *
 * 認証: CRON_SECRET を `Authorization: Bearer <secret>` で渡す。
 *
 * リクエスト Body (JSON, 全て optional):
 *   - dryRun: boolean       … true なら CAPI 送信せず候補一覧のみ返す
 *   - maxAgeDays: number    … followed_at が新しいほど Attribution 寄与が高い。デフォルト 7、上限 62
 *   - limit: number         … 1 回のリクエストで処理する最大件数。デフォルト 500、上限 2000
 *
 * 使い方の例:
 *   curl -X POST https://<your-domain>/api/admin/backfill-capi \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"dryRun": true, "maxAgeDays": 7}'
 */
export async function POST(request: NextRequest) {
    const authHeader = request.headers.get('authorization')
    if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: '認証エラー' }, { status: 401 })
    }

    let body: { dryRun?: boolean; maxAgeDays?: number; limit?: number } = {}
    try {
        body = await request.json()
    } catch {
        // body 省略可
    }

    const dryRun = body.dryRun === true
    const maxAgeDays = Math.min(Math.max(body.maxAgeDays ?? 7, 1), 62)
    const limit = Math.min(Math.max(body.limit ?? 500, 1), 2000)

    const supabase = createAdminClient()
    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const cutoffIso = new Date(cutoffMs).toISOString()

    // pending 行を抽出 (created_at で絞ることで対象を小さくしておく)
    const { data: pendings, error } = await supabase
        .from('ad_conversions')
        .select('id, channel_id, line_user_id, fbclid, created_at')
        .eq('status', 'pending')
        .gte('created_at', cutoffIso)
        .order('created_at', { ascending: false })
        .limit(limit)

    if (error) {
        console.error('backfill: pending 取得エラー', error)
        return NextResponse.json({ error: '取得失敗' }, { status: 500 })
    }

    if (!pendings || pendings.length === 0) {
        return NextResponse.json({
            dryRun,
            maxAgeDays,
            candidates: 0,
            sent: 0,
            skipped: 0,
            failed: 0,
            message: '対象 pending 行なし',
        })
    }

    const results = {
        dryRun,
        maxAgeDays,
        candidates: 0,
        sent: 0,
        skipped: 0,
        failed: 0,
        details: [] as Array<{
            line_user_id: string
            fbclid: string | null
            followed_at: string | null
            outcome: string
        }>,
    }

    for (const row of pendings) {
        const { data: user } = await supabase
            .from('line_users')
            .select('followed_at, is_blocked')
            .eq('channel_id', row.channel_id)
            .eq('line_user_id', row.line_user_id)
            .maybeSingle()

        if (!user?.followed_at || user.is_blocked) {
            results.skipped++
            results.details.push({
                line_user_id: row.line_user_id,
                fbclid: row.fbclid,
                followed_at: user?.followed_at ?? null,
                outcome: user?.is_blocked ? 'skipped:blocked' : 'skipped:no_follow',
            })
            continue
        }

        const followedAtMs = new Date(user.followed_at).getTime()
        if (followedAtMs < cutoffMs) {
            results.skipped++
            results.details.push({
                line_user_id: row.line_user_id,
                fbclid: row.fbclid,
                followed_at: user.followed_at,
                outcome: 'skipped:out_of_window',
            })
            continue
        }

        results.candidates++

        if (dryRun) {
            results.details.push({
                line_user_id: row.line_user_id,
                fbclid: row.fbclid,
                followed_at: user.followed_at,
                outcome: 'dry_run',
            })
            continue
        }

        try {
            const sendResult = await sendMetaCapiEvent(
                supabase,
                row.channel_id,
                row.line_user_id,
                { eventTimeSeconds: Math.floor(followedAtMs / 1000) }
            )
            if (sendResult.status === 'sent') {
                results.sent++
                results.details.push({
                    line_user_id: row.line_user_id,
                    fbclid: row.fbclid,
                    followed_at: user.followed_at,
                    outcome: 'sent',
                })
            } else {
                results.failed++
                results.details.push({
                    line_user_id: row.line_user_id,
                    fbclid: row.fbclid,
                    followed_at: user.followed_at,
                    outcome: `failed:${sendResult.status}`,
                })
            }
            // Meta CAPI のレート制限回避のため小休止
            await new Promise(resolve => setTimeout(resolve, 80))
        } catch (err) {
            results.failed++
            console.error(`backfill 送信エラー (${row.line_user_id}):`, err)
            results.details.push({
                line_user_id: row.line_user_id,
                fbclid: row.fbclid,
                followed_at: user.followed_at,
                outcome: 'failed:exception',
            })
        }
    }

    return NextResponse.json(results)
}
