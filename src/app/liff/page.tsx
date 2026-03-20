'use client'

import { useEffect } from 'react'

export default function LiffPage() {
    useEffect(() => {
        const run = async () => {
            // URLパラメータ取得
            const params = new URLSearchParams(window.location.search)
            const fbclid = params.get('fbclid')
            const tag = params.get('tag')
            const ch = params.get('ch')   // channel UUID（SupabaseのchannelsテーブルのID）
            const oa = params.get('oa')   // LINE公式アカウントのbasic ID（例: @xxxxx）

            // LIFF初期化（動的importでSSRエラーを回避）
            const liff = (await import('@line/liff')).default
            await liff.init({ liffId: process.env.NEXT_PUBLIC_LIFF_ID! })

            // 未ログインの場合はLINEログインへ（通常は発生しない）
            if (!liff.isLoggedIn()) {
                liff.login({ redirectUri: window.location.href })
                return
            }

            // LINE UIDを取得
            const profile = await liff.getProfile()
            const lineUserId = profile.userId

            // Supabaseにad_conversionを保存（Fire and Forget）
            // レスポンスを待たずにリダイレクトするため離脱ゼロ
            if (ch && lineUserId) {
                fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/ad_conversions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
                        'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}`,
                        'Prefer': 'return=minimal',
                    },
                    body: JSON.stringify({
                        channel_id: ch,
                        line_user_id: lineUserId,
                        fbclid: fbclid || null,
                        tag: tag || null,
                    }),
                }).catch(err => console.error('Supabase保存エラー:', err))
            }

            // LINEトーク画面へリダイレクト
            if (oa) {
                window.location.href = `https://line.me/R/ti/p/${oa}`
            } else {
                liff.closeWindow()
            }
        }

        run().catch(console.error)
    }, [])

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            height: '100vh',
            fontFamily: 'sans-serif',
            backgroundColor: '#ffffff',
            gap: '24px',
        }}>
            <style>{`
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                .line-spinner {
                    width: 52px;
                    height: 52px;
                    border: 5px solid #d4f5e2;
                    border-top-color: #06C755;
                    border-radius: 50%;
                    animation: spin 0.85s linear infinite;
                }
            `}</style>
            <div className="line-spinner" />
            <p style={{ color: '#06C755', fontSize: '22px', fontWeight: 'bold', margin: 0 }}>
                LINE接続中...
            </p>
            <p style={{ color: '#555555', fontSize: '15px', margin: 0, textAlign: 'center', lineHeight: '1.8' }}>
                LINEに接続しています。<br />そのままお待ちください。<br />画面を閉じないでください。
            </p>
        </div>
    )
}
