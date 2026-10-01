import { NextRequest, NextResponse } from 'next/server'
import { syncScheduledRichMenus } from '@/lib/rich-menu/sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * リッチメニュー表示期間に基づく自動切替Cronジョブ
 * GET /api/cron/rich-menu-switch
 *
 * 表示期間中のメニュー → なければ基本のメニュー を、全員向け（LINE のデフォルト）として設定する。
 * LINE に実際に設定されているデフォルトと比べて違うときだけ付け替えるので、何度呼んでも安全。
 * 同じ処理は /api/cron/tick（5分ごと）でも行っている。
 */
export async function GET(request: NextRequest) {
    // Cron認証
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: '認証エラー' }, { status: 401 })
    }

    try {
        const results = await syncScheduledRichMenus()
        return NextResponse.json({
            success: true,
            processedAt: new Date().toISOString(),
            results,
        })
    } catch (error) {
        console.error('リッチメニュー切替Cronエラー:', error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
