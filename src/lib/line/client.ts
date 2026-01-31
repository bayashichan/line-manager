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
            throw new Error(`リッチメニュー画像アップロードに失敗: ${response.status}`)
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
