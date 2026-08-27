import crypto from 'crypto'
import type { Channel } from '@/types'

/**
 * LINE Webhook署名を検証する
 */
export function validateSignature(
    body: string,
    signature: string,
    channelSecret: string
): boolean {
    const hash = crypto
        .createHmac('sha256', channelSecret)
        .update(body)
        .digest('base64')
    return hash === signature
}

export type LineProfile = {
    userId: string
    displayName: string
    pictureUrl?: string
    statusMessage?: string
}

/**
 * 友だち判定の結果。
 * - friend:     このチャネルの友だち（プロフィール取得成功）
 * - not_friend: 友だちでない、またはブロック中
 * - error:      判定できなかった（トークン不正・通信障害など）。友だちでないと断定してはいけない
 */
export type FriendCheckResult =
    | { status: 'friend'; profile: LineProfile }
    | { status: 'not_friend'; httpStatus: number }
    | { status: 'error'; httpStatus: number; detail: string }

/**
 * LINE Messaging API クライアント
 */
export class LineClient {
    private accessToken: string
    private baseUrl = 'https://api.line.me/v2/bot'

    constructor(accessToken: string) {
        this.accessToken = accessToken
    }

    /**
     * 共通のfetchラッパー
     */
    private async request(
        endpoint: string,
        options: RequestInit = {}
    ): Promise<Response> {
        const url = `${this.baseUrl}${endpoint}`
        const response = await fetch(url, {
            ...options,
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
                ...options.headers,
            },
        })
        return response
    }

    /**
     * ユーザープロフィールを取得
     */
    async getProfile(userId: string) {
        const response = await this.request(`/profile/${userId}`)
        if (!response.ok) {
            throw new Error(`プロフィール取得に失敗: ${response.status}`)
        }
        return response.json() as Promise<{
            userId: string
            displayName: string
            pictureUrl?: string
            statusMessage?: string
        }>
    }

    /**
     * 友だちかどうかを判定しつつプロフィールを取得する。
     *
     * GET /v2/bot/profile/{userId} は、そのチャネルの友だちでない場合や
     * ブロック中の場合に 404 を返す。getProfile() は失敗を一律で例外にするため、
     * 「非友だち」と「トークン不正・通信障害」を区別できない。
     * 友だち判定の用途ではこちらを使うこと。
     */
    async getProfileForFriendCheck(userId: string): Promise<FriendCheckResult> {
        let response: Response
        try {
            response = await this.request(`/profile/${userId}`)
        } catch (err) {
            return { status: 'error', httpStatus: 0, detail: String(err) }
        }

        if (response.ok) {
            const profile = (await response.json()) as LineProfile
            return { status: 'friend', profile }
        }

        // 404: 友だちでない or ブロック中 / 403: そのuserIdにアクセスする権限がない
        if (response.status === 404 || response.status === 403) {
            return { status: 'not_friend', httpStatus: response.status }
        }

        // 401(トークン不正)や5xxは「非友だち」ではないので区別する
        const detail = await response.text().catch(() => '')
        return { status: 'error', httpStatus: response.status, detail }
    }

    /**
     * メッセージを返信
     */
    async replyMessage(replyToken: string, messages: object[], notificationDisabled: boolean = false) {
        const body: any = {
            replyToken,
            messages
        }

        if (notificationDisabled) {
            body.notificationDisabled = true
        }

        const response = await this.request('/message/reply', {
            method: 'POST',
            body: JSON.stringify(body),
        })
        if (!response.ok) {
            const error = await response.json()
            throw new Error(`メッセージ返信に失敗: ${JSON.stringify(error)}`)
        }
        return response.json()
    }

    /**
     * プッシュメッセージを送信
     */
    async pushMessage(userId: string, messages: object[], notificationDisabled: boolean = false) {
        const body: any = {
            to: userId,
            messages
        }

        // trueの場合のみプロパティを追加（falseの場合は送信しない＝デフォルト設定に任せる）
        if (notificationDisabled) {
            body.notificationDisabled = true
        }

        const response = await this.request('/message/push', {
            method: 'POST',
            body: JSON.stringify(body),
        })
        if (!response.ok) {
            const error = await response.json()
            throw new Error(`メッセージ送信に失敗: ${JSON.stringify(error)}`)
        }
        return response.json()
    }

    /**
     * マルチキャストメッセージを送信（最大500人）
     */
    async multicast(userIds: string[], messages: object[], notificationDisabled: boolean = false) {
        const body: any = {
            to: userIds,
            messages
        }

        // trueの場合のみプロパティを追加
        if (notificationDisabled) {
            body.notificationDisabled = true
        }

        const response = await this.request('/message/multicast', {
            method: 'POST',
            body: JSON.stringify(body),
        })
        if (!response.ok) {
            const error = await response.json()
            throw new Error(`マルチキャスト送信に失敗: ${JSON.stringify(error)}`)
        }
        return response.json()
    }

    // =========================================================================
    // リッチメニュー関連
    // =========================================================================

    /**
     * リッチメニューを作成
     */
    async createRichMenu(richMenuObject: object): Promise<{ richMenuId: string }> {
        const response = await this.request('/richmenu', {
            method: 'POST',
            body: JSON.stringify(richMenuObject),
        })
        if (!response.ok) {
            const error = await response.json()
            throw new Error(`リッチメニュー作成に失敗: ${JSON.stringify(error)}`)
        }
        return response.json()
    }

    /**
     * リッチメニューに画像をアップロード
     */
    async uploadRichMenuImage(richMenuId: string, imageBlob: Blob, contentType: string) {
        const url = `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': contentType,
            },
            body: imageBlob,
        })
        if (!response.ok) {
            // 413（1MB超）やフォーマット不正の切り分けができるようレスポンス本文も残す
            const detail = await response.text().catch(() => '')
            throw new Error(
                `リッチメニュー画像アップロードに失敗: ${response.status}${detail ? ` ${detail}` : ''}`
            )
        }
    }



    /**
     * リッチメニューをユーザーにリンク
     */
    async linkRichMenuToUser(userId: string, richMenuId: string) {
        const response = await this.request(`/user/${userId}/richmenu/${richMenuId}`, {
            method: 'POST',
        })
        if (!response.ok) {
            throw new Error(`リッチメニューリンクに失敗: ${response.status}`)
        }
    }

    /**
     * ユーザーのリッチメニューをアンリンク
     */
    async unlinkRichMenuFromUser(userId: string) {
        const response = await this.request(`/user/${userId}/richmenu`, {
            method: 'DELETE',
        })
        if (!response.ok) {
            throw new Error(`リッチメニューアンリンクに失敗: ${response.status}`)
        }
    }

    /**
     * デフォルトリッチメニューを設定
     */
    async setDefaultRichMenu(richMenuId: string) {
        const response = await this.request(`/user/all/richmenu/${richMenuId}`, {
            method: 'POST',
        })
        if (!response.ok) {
            throw new Error(`デフォルトリッチメニュー設定に失敗: ${response.status}`)
        }
    }

    /**
     * リッチメニューを削除
     */
    async deleteRichMenu(richMenuId: string) {
        const response = await this.request(`/richmenu/${richMenuId}`, {
            method: 'DELETE',
        })
        if (!response.ok) {
            throw new Error(`リッチメニュー削除に失敗: ${response.status}`)
        }
    }

    /**
     * リッチメニュー一覧を取得
     */
    async getRichMenuList() {
        const response = await this.request('/richmenu/list')
        if (!response.ok) {
            throw new Error(`リッチメニュー一覧取得に失敗: ${response.status}`)
        }
        return response.json() as Promise<{ richmenus: object[] }>
    }
}

/**
 * チャンネル情報からLINEクライアントを作成
 */
export function createLineClient(channel: Channel): LineClient {
    return new LineClient(channel.channel_access_token)
}
