import { NextRequest, NextResponse } from 'next/server'
import { deliverDueStepMessages } from '@/lib/step/deliver-due'

/**
 * ステップ配信を処理するCronジョブ
 * GET /api/cron/step-messages
 *
 * 送信処理は src/lib/step/deliver-due.ts（/api/cron/tick からも呼ばれる）。
 */
export async function GET(request: NextRequest) {
    try {
        // Cronシークレットをチェック（本番環境用）
        const authHeader = request.headers.get('authorization')
        if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: '認証エラー' }, { status: 401 })
        }

        const result = await deliverDueStepMessages()
        if (!result.ok) {
            return NextResponse.json({ error: '取得エラー' }, { status: 500 })
        }
        if (result.processed === 0) {
            return NextResponse.json({ processed: 0 })
        }

        return NextResponse.json({
            success: true,
            processed: result.processed,
        })
    } catch (error) {
        console.error('Cronジョブエラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
