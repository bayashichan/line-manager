'use client'

import { useEffect, useState } from 'react'

export default function LiffPage() {
    const [isInAppBrowser, setIsInAppBrowser] = useState(false)
    const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null)
    const [showFallback, setShowFallback] = useState(false)

    useEffect(() => {
        const ua = navigator.userAgent || ''
        const isInstagramFacebook = /Instagram|FBAN|FBAV/i.test(ua)

        if (isInstagramFacebook) {
            // Android/iOS問わずIABではボタン表示（LIFF initはIABで動作しない）
            setIsInAppBrowser(true)
            return
        }

        // 通常フロー: LIFF初期化
        const run = async () => {
            // LINE が params を liff.state に包む場合があるため両方から展開する
            const urlParams = new URLSearchParams(window.location.search)
            const liffState = urlParams.get('liff.state')
            const params = liffState
                ? new URLSearchParams(decodeURIComponent(liffState).replace(/^\?/, ''))
                : urlParams
            const fbclid = params.get('fbclid')
            const fbp = params.get('fbp')
            const tag = params.get('tag')
            const ch = params.get('ch')
            const oa = params.get('oa')

            const liff = (await import('@line/liff')).default
            await liff.init({ liffId: process.env.NEXT_PUBLIC_LIFF_ID! })

            if (!liff.isLoggedIn()) {
                liff.login({ redirectUri: window.location.href })
                return
            }

            const profile = await liff.getProfile()
            const lineUserId = profile.userId

            if (ch && lineUserId) {
                // /api/track 経由で保存することでサーバー側がクライアントIPを取得できる
                await fetch('/api/track', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        channel_id: ch,
                        line_user_id: lineUserId,
                        fbclid: fbclid || null,
                        fbp: fbp || null,
                        tag: tag || null,
                        user_agent: navigator.userAgent,
                        event_source_url: 'https://updatehayashi.jp/',
                    }),
                }).catch(err => console.error('トラッキング保存エラー:', err))
            }

            if (oa) {
                // LINE Login authorize URL を構築 (bot_prompt=aggressive で友だち追加/ブロック解除を促す)
                const loginChannelId = process.env.NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID
                const appUrl = process.env.NEXT_PUBLIC_APP_URL || window.location.origin

                if (!loginChannelId) {
                    console.error('NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID が設定されていません')
                    return
                }

                const state = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
                    ? crypto.randomUUID()
                    : Math.random().toString(36).slice(2) + Date.now().toString(36)
                try {
                    sessionStorage.setItem('line_login_state', state)
                } catch {
                    // sessionStorage が使えない環境では無視
                }

                const redirectUri = `${appUrl}/api/line-login/callback`
                const url = `https://access.line.me/oauth2/v2.1/authorize?` +
                    `response_type=code&` +
                    `client_id=${encodeURIComponent(loginChannelId)}&` +
                    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
                    `state=${encodeURIComponent(state)}&` +
                    `scope=${encodeURIComponent('profile openid')}&` +
                    `bot_prompt=aggressive`

                setAuthorizeUrl(url)
                // 自動遷移
                window.location.href = url
            } else {
                liff.closeWindow()
            }
        }

        run().catch(console.error)
    }, [])

    // 自動遷移が失敗した場合に備え、3秒後にタップボタンを表示
    useEffect(() => {
        if (!authorizeUrl) return
        const timer = setTimeout(() => setShowFallback(true), 3000)
        return () => clearTimeout(timer)
    }, [authorizeUrl])

    // Instagram/Facebook内ブラウザ用のUI
    if (isInAppBrowser) {
        const liffId = process.env.NEXT_PUBLIC_LIFF_ID || ''
        const isIOS = typeof window !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)

        // liff.stateがある場合は元のパラメータをデコードして取り出す
        const getCleanParams = (): string => {
            if (typeof window === 'undefined') return ''
            const urlParams = new URLSearchParams(window.location.search)
            const liffState = urlParams.get('liff.state')
            if (liffState) {
                try {
                    const decoded = decodeURIComponent(liffState).replace(/^\?/, '')
                    const decodedParams = new URLSearchParams(decoded)
                    const clean = new URLSearchParams()
                    for (const key of ['fbclid', 'fbp', 'tag', 'ch', 'oa']) {
                        const val = decodedParams.get(key)
                        if (val) clean.set(key, val)
                    }
                    return clean.toString()
                } catch {
                    return ''
                }
            }
            const clean = new URLSearchParams()
            for (const key of ['fbclid', 'fbp', 'tag', 'ch', 'oa']) {
                const val = urlParams.get(key)
                if (val) clean.set(key, val)
            }
            return clean.toString()
        }

        const cleanParams = getCleanParams()
        const paramSuffix = cleanParams ? `?${cleanParams}` : ''

        const lineOpenUrl = isIOS
            // iOS: クッションページ経由でLINEアプリ確実起動（WKWebViewはユニバーサルリンク非対応）
            ? `https://line.me/R/app/${liffId}${paramSuffix}`
            // Android: intent://でLINEアプリを直接起動（IABのApp Link制限を完全回避）
            : `intent://app/${liffId}${paramSuffix}#Intent;scheme=line;package=jp.naver.line.android;end`

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
                    LINEアプリで開きます
                </p>
                <p style={{ color: '#666', fontSize: '14px', margin: 0, textAlign: 'center', lineHeight: '1.7' }}>
                    友だち追加するために<br />LINEアプリに移動します
                </p>
                <a
                    href={lineOpenUrl}
                    style={{
                        display: 'block',
                        width: '100%',
                        maxWidth: '300px',
                        padding: '16px 0',
                        backgroundColor: '#06C755',
                        color: '#fff',
                        textAlign: 'center',
                        textDecoration: 'none',
                        fontWeight: 'bold',
                        fontSize: '17px',
                        borderRadius: '8px',
                        marginTop: '8px',
                    }}
                >
                    LINEで開く
                </a>
                <p style={{ color: '#999', fontSize: '12px', margin: 0 }}>
                    ※LINEアプリが起動します
                </p>
            </div>
        )
    }

    // LIFF 処理中・LINE Login 自動遷移中のローディング表示
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
                LINE接続中...
            </p>
            <p style={{ color: '#555555', fontSize: '15px', margin: 0, textAlign: 'center', lineHeight: '1.8' }}>
                LINEに接続しています。<br />そのままお待ちください。<br />画面を閉じないでください。
            </p>
            {showFallback && authorizeUrl && (
                <a
                    href={authorizeUrl}
                    style={{
                        display: 'block',
                        width: '100%',
                        maxWidth: '300px',
                        padding: '16px 0',
                        backgroundColor: '#06C755',
                        color: '#fff',
                        textAlign: 'center',
                        textDecoration: 'none',
                        fontWeight: 'bold',
                        fontSize: '17px',
                        borderRadius: '8px',
                        marginTop: '8px',
                    }}
                >
                    続ける
                </a>
            )}
        </div>
    )
}
