import { NextRequest, NextResponse } from 'next/server'

/**
 * LINE Login OAuth コールバックエンドポイント
 * GET /api/line-login/callback
 *
 * LINE Login で bot_prompt=aggressive を使った認可フローのコールバック先。
 * code を access token + id_token に交換し、line_user_id を抽出して
 * 友だち追加の結果に応じて成功/失敗ページにリダイレクトする。
 */
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const friendshipStatusChanged = searchParams.get('friendship_status_changed')
    const error = searchParams.get('error')
    const errorDescription = searchParams.get('error_description')

    const successPath = '/line-login/success'

    if (error) {
        console.error('LINE Login error:', error, errorDescription)
        const url = new URL(successPath, request.url)
        url.searchParams.set('status', 'error')
        url.searchParams.set('reason', error)
        return NextResponse.redirect(url)
    }

    if (!code || !state) {
        const url = new URL(successPath, request.url)
        url.searchParams.set('status', 'error')
        url.searchParams.set('reason', 'missing_params')
        return NextResponse.redirect(url)
    }

    const channelId = process.env.NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID
    const channelSecret = process.env.LINE_LOGIN_CHANNEL_SECRET
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin

    if (!channelId || !channelSecret) {
        console.error('LINE Login channel credentials not configured')
        const url = new URL(successPath, request.url)
        url.searchParams.set('status', 'error')
        url.searchParams.set('reason', 'config_missing')
        return NextResponse.redirect(url)
    }

    try {
        // code を access token + id_token に交換
        const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: `${appUrl}/api/line-login/callback`,
                client_id: channelId,
                client_secret: channelSecret,
            }).toString(),
        })

        if (!tokenRes.ok) {
            const errBody = await tokenRes.text()
            console.error('Token exchange failed:', tokenRes.status, errBody)
            const url = new URL(successPath, request.url)
            url.searchParams.set('status', 'error')
            url.searchParams.set('reason', 'token_exchange_failed')
            return NextResponse.redirect(url)
        }

        const tokenData = await tokenRes.json()
        // id_token から line_user_id (sub) を取得 (verify は省略 - 信頼できるソースから直接取得済み)
        let lineUserId: string | null = null
        if (tokenData.id_token) {
            try {
                const payloadB64 = tokenData.id_token.split('.')[1]
                const payload = JSON.parse(
                    Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
                )
                lineUserId = payload.sub || null
            } catch (e) {
                console.error('id_token decode error:', e)
            }
        }

        console.log('LINE Login callback:', {
            lineUserId,
            friendshipStatusChanged,
            state,
        })

        // 友だち追加結果に応じてリダイレクト
        const url = new URL(successPath, request.url)
        if (friendshipStatusChanged === 'true') {
            url.searchParams.set('status', 'added')
        } else if (friendshipStatusChanged === 'false') {
            // ユーザーが拒否したか、または既に友だちだった
            url.searchParams.set('status', 'no_change')
        } else {
            // friendship_status_changed が無い = bot_prompt が表示されなかった (既に友だち済みなど)
            url.searchParams.set('status', 'already_friend')
        }
        return NextResponse.redirect(url)
    } catch (e: any) {
        console.error('LINE Login callback error:', e)
        const url = new URL(successPath, request.url)
        url.searchParams.set('status', 'error')
        url.searchParams.set('reason', 'internal')
        return NextResponse.redirect(url)
    }
}
