'use client'

import { useEffect, useState } from 'react'

export default function BridgePage() {
    const [isInAppBrowser, setIsInAppBrowser] = useState(false)
    const [lineOpenUrl, setLineOpenUrl] = useState<string | null>(null)

    useEffect(() => {
        const ua = navigator.userAgent || ''
        const isInstagramFacebook = /Instagram|FBAN|FBAV|\[FB_IAB\]/i.test(ua)
        const isIOS = /iPhone|iPad|iPod/i.test(ua)

        const urlParams = new URLSearchParams(window.location.search)
        const oa = urlParams.get('oa') ?? ''

        if (!oa) {
            console.error('bridge: oaパラメータがありません')
            return
        }

        const encodedOa = encodeURIComponent(oa)

        if (!isInstagramFacebook) {
            // 通常ブラウザ（Safari / Chrome等）: LINEアプリの友達追加画面へ直接遷移
            window.location.href = `https://line.me/R/ti/p/${encodedOa}`
            return
        }

        // IABブラウザ: ボタン表示
        const url = isIOS
            // iOS: line.meユニバーサルリンクでLINEアプリ起動（WKWebViewでも動作）
            ? `https://line.me/R/ti/p/${encodedOa}`
            // Android: intentスキームでLINEアプリを直接起動（App Link制限を回避）
            : `intent://ti/p/${encodedOa}#Intent;scheme=line;package=jp.naver.line.android;end`

        setLineOpenUrl(url)
        setIsInAppBrowser(true)
    }, [])

    if (isInAppBrowser && lineOpenUrl) {
        return (
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                height: '100vh',
                fontFamily: 'sans-serif',
                backgroundColor: '#ffffff',
                gap: '20px',
                padding: '0 24px',
            }}>
                <div style={{
                    width: '64px',
                    height: '64px',
                    borderRadius: '16px',
                    backgroundColor: '#06C755',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                }}>
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="white">
                        <path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M12 1.004C5.926 1.004 1 5.037 1 9.995c0 2.42 1.206 4.596 3.16 6.229.135.112.33.27.48.399-.244 1.024-.787 3.235-.812 3.451-.031.262.1.392.212.432.082.03.178.035.282-.022.135-.075 3.306-2.176 3.834-2.525.529.076 1.073.134 1.627.164l.263.009c.46 0 .917-.022 1.365-.065C12.06 18.065 12.98 18 14 18c6.075 0 11-4.035 11-8.995C25 4.035 18.075 1.004 12 1.004" />
                    </svg>
                </div>
                <p style={{ color: '#333', fontSize: '20px', fontWeight: 'bold', margin: 0, textAlign: 'center' }}>
                    LINEで友達追加する
                </p>
                <p style={{ color: '#666', fontSize: '14px', margin: 0, textAlign: 'center', lineHeight: '1.7' }}>
                    下のボタンをタップして<br />LINEで友達追加してください
                </p>
                <a
                    href={lineOpenUrl}
                    style={{
                        display: 'block',
                        width: '100%',
                        maxWidth: '300px',
                        padding: '16px 0',
                        backgroundColor: '#2d6b3e',
                        color: '#fff',
                        textAlign: 'center',
                        textDecoration: 'none',
                        fontWeight: 'bold',
                        fontSize: '17px',
                        borderRadius: '8px',
                        marginTop: '8px',
                    }}
                >
                    LINEで友達追加する
                </a>
                <p style={{ color: '#999', fontSize: '12px', margin: 0 }}>
                    ※LINEアプリが起動します
                </p>
            </div>
        )
    }

    // 通常ブラウザでのリダイレクト中 / 初期レンダリング
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
            padding: '0 24px',
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
                LINEに移動中...
            </p>
            <p style={{ color: '#555555', fontSize: '15px', margin: 0, textAlign: 'center', lineHeight: '1.8' }}>
                LINEアプリに移動しています。<br />そのままお待ちください。
            </p>
        </div>
    )
}
