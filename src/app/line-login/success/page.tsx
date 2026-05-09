'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

function SuccessContent() {
    const searchParams = useSearchParams()
    const status = searchParams.get('status') || 'added'
    const reason = searchParams.get('reason') || ''

    let title = '友だち追加が完了しました'
    let message = 'LINEアプリに戻ってメッセージをご確認ください'
    let isError = false

    switch (status) {
        case 'added':
            title = '友だち追加が完了しました'
            message = 'LINEアプリに戻ってメッセージをご確認ください'
            break
        case 'already_friend':
            title = 'すでに友だち追加済みです'
            message = 'LINEアプリでメッセージをご確認ください'
            break
        case 'no_change':
            title = '友だち追加が完了しませんでした'
            message = 'もう一度お試しください'
            isError = true
            break
        case 'error':
            title = 'エラーが発生しました'
            message = reason ? `理由: ${reason}` : 'もう一度お試しください'
            isError = true
            break
    }

    const iconColor = isError ? '#dc2626' : '#06C755'

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '100vh',
            fontFamily: 'sans-serif',
            backgroundColor: '#ffffff',
            gap: '20px',
            padding: '0 24px',
        }}>
            <div style={{
                width: '64px',
                height: '64px',
                borderRadius: '16px',
                backgroundColor: iconColor,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
            }}>
                {isError ? (
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="white">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z" />
                    </svg>
                ) : (
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="white">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                    </svg>
                )}
            </div>
            <p style={{ color: '#333', fontSize: '20px', fontWeight: 'bold', margin: 0, textAlign: 'center' }}>
                {title}
            </p>
            <p style={{ color: '#666', fontSize: '14px', margin: 0, textAlign: 'center', lineHeight: '1.7' }}>
                {message}
            </p>
            <a
                href="line://"
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
                LINEアプリに戻る
            </a>
        </div>
    )
}

export default function LineLoginSuccessPage() {
    return (
        <Suspense fallback={<div />}>
            <SuccessContent />
        </Suspense>
    )
}
