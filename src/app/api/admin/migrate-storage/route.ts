import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { isR2Configured } from '@/lib/storage/r2'
import { copyObjects, rewriteDatabase } from '@/lib/storage/migrate'

/**
 * Supabase Storage → R2 移行 (ワンショット管理用エンドポイント)
 * POST /api/admin/migrate-storage
 *
 * 画像・動画の配信元をR2へ移したあと、過去にSupabase Storageへ上げた
 * アセットを移し、DBに保存済みの公開URLを書き換えるためのもの。
 * Vercel上で動くので、手元にSupabase/R2の認証情報を用意しなくてよい。
 *
 * 認証: CRON_SECRET を `Authorization: Bearer <secret>` で渡す。
 *
 * リクエスト Body (JSON, 全て optional):
 *   - step: 'copy' | 'rewrite'  … copy=R2への複製（既定）, rewrite=DBのURL書き換え
 *   - dryRun: boolean           … true なら書き込まず件数だけ返す
 *   - limit: number             … copy で1回に処理する最大件数。デフォルト 50、上限 500
 *
 * 使い方:
 *   1) curl -X POST https://<your-domain>/api/admin/migrate-storage \
 *        -H "Authorization: Bearer $CRON_SECRET" \
 *        -H "Content-Type: application/json" \
 *        -d '{"dryRun": true}'
 *   2) dryRun を外して実行。remaining が 0 になるまで繰り返す
 *   3) -d '{"step": "rewrite", "dryRun": true}' で件数を確認してから本実行
 *   4) 画像表示を確認したら
 *      supabase/migrations/20260921000000_revoke_public_storage_read.sql を適用する
 */

// ファイルの複製に時間がかかるため上限まで伸ばす（Vercel Proで300秒）
export const maxDuration = 300

export async function POST(request: NextRequest) {
    const authHeader = request.headers.get('authorization')
    if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: '認証エラー' }, { status: 401 })
    }

    if (!isR2Configured()) {
        return NextResponse.json(
            { error: 'ファイル配信用のR2が未設定です（R2_* の環境変数を確認してください）' },
            { status: 503 }
        )
    }

    let body: { step?: string; dryRun?: boolean; limit?: number } = {}
    try {
        body = await request.json()
    } catch {
        // body 省略可
    }

    const step = body.step === 'rewrite' ? 'rewrite' : 'copy'
    const dryRun = body.dryRun === true
    const limit = Math.min(Math.max(body.limit ?? 50, 1), 500)

    const supabase = createAdminClient()

    try {
        if (step === 'rewrite') {
            const report = await rewriteDatabase(supabase, dryRun)
            return NextResponse.json({
                step,
                dryRun,
                report,
                message: dryRun
                    ? '書き換え対象の件数です。dryRun を外すと実際に更新します'
                    : 'DBのURLを書き換えました。画像が表示されるか確認してください',
            })
        }

        const result = await copyObjects(supabase, limit, dryRun)
        return NextResponse.json({
            step,
            dryRun,
            ...result,
            message:
                result.remaining > 0
                    ? `残り ${result.remaining} 件。同じリクエストを remaining が 0 になるまで繰り返してください`
                    : 'すべて複製済みです。次は step=rewrite を実行してください',
        })
    } catch (e) {
        console.error('migrate-storage エラー:', e)
        return NextResponse.json(
            { error: e instanceof Error ? e.message : '移行処理に失敗しました' },
            { status: 500 }
        )
    }
}
