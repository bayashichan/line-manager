import type { LineClient } from '@/lib/line'
import { extensionForContentType, isR2Configured, uploadToR2 } from '@/lib/storage/r2'

/**
 * 友だちから届いたメッセージを1:1チャットで表示できる形に変換する。
 *
 * LINEのWebhookは画像・動画・音声・ファイルの実体を送ってこない（messageIdだけ）。
 * 変換せずにそのまま保存すると、チャット画面には空の吹き出ししか出ず、
 * LINE公式アカウントアプリで見えているやり取りと食い違ってしまう。
 * ここでコンテンツAPIから実体を取得してR2に保存し、表示可能なURLを埋め込む。
 */

/** LINEのスタンプ画像は公開CDNから取得できるので、実体の保存は不要 */
function stickerUrl(stickerId: string): string {
    return `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/android/sticker.png`
}

export type IncomingMessage = {
    type: string
    id?: string
    text?: string
    packageId?: string
    stickerId?: string
    fileName?: string
    fileSize?: number
    title?: string
    address?: string
    latitude?: number
    longitude?: number
    duration?: number
    [key: string]: unknown
}

export type NormalizedIncoming = {
    contentType: string
    content: Record<string, unknown>
    /** 友だちリストのプレビュー用テキスト */
    preview: string
}

/** メディアの保存に使うキー。チャンネルごとに分けて衝突を避ける */
function mediaKey(channelId: string, messageId: string, ext: string): string {
    return `line-inbound/${channelId}/${messageId}.${ext}`
}

/**
 * 実体をLINEから取得してR2に保存する。
 * 取得も保存も失敗しうる（コンテンツの保持期限切れ、R2未設定など）ので、
 * 失敗時は null を返してテキストだけのフォールバック表示に任せる。
 */
async function storeMedia(
    lineClient: LineClient,
    channelId: string,
    messageId: string
): Promise<{ url: string; contentType: string } | null> {
    if (!isR2Configured()) return null

    try {
        const { buffer, contentType } = await lineClient.getMessageContent(messageId)
        const ext = extensionForContentType(contentType)
        const url = await uploadToR2({
            key: mediaKey(channelId, messageId, ext),
            body: new Uint8Array(buffer),
            contentType,
        })
        return url ? { url, contentType } : null
    } catch (error) {
        console.error(`受信メディアの保存に失敗 (messageId: ${messageId}):`, error)
        return null
    }
}

export async function normalizeIncomingMessage(
    lineClient: LineClient,
    channelId: string,
    message: IncomingMessage
): Promise<NormalizedIncoming> {
    switch (message.type) {
        case 'text':
            return {
                contentType: 'text',
                content: { type: 'text', text: message.text ?? '' },
                preview: message.text ?? '',
            }

        case 'sticker': {
            const url = message.stickerId ? stickerUrl(message.stickerId) : null
            return {
                contentType: 'sticker',
                content: {
                    type: 'sticker',
                    packageId: message.packageId,
                    stickerId: message.stickerId,
                    ...(url ? { originalContentUrl: url, previewImageUrl: url } : {}),
                },
                preview: 'スタンプが送信されました',
            }
        }

        case 'image': {
            const stored = message.id ? await storeMedia(lineClient, channelId, message.id) : null
            return {
                contentType: 'image',
                content: {
                    type: 'image',
                    ...(stored
                        ? { originalContentUrl: stored.url, previewImageUrl: stored.url }
                        : {}),
                },
                preview: '画像が送信されました',
            }
        }

        case 'video': {
            const stored = message.id ? await storeMedia(lineClient, channelId, message.id) : null
            return {
                contentType: 'video',
                content: {
                    type: 'video',
                    duration: message.duration,
                    ...(stored ? { originalContentUrl: stored.url } : {}),
                },
                preview: '動画が送信されました',
            }
        }

        case 'audio': {
            const stored = message.id ? await storeMedia(lineClient, channelId, message.id) : null
            return {
                contentType: 'audio',
                content: {
                    type: 'audio',
                    duration: message.duration,
                    ...(stored ? { originalContentUrl: stored.url } : {}),
                },
                preview: '音声が送信されました',
            }
        }

        case 'file': {
            const stored = message.id ? await storeMedia(lineClient, channelId, message.id) : null
            return {
                contentType: 'file',
                content: {
                    type: 'file',
                    fileName: message.fileName,
                    fileSize: message.fileSize,
                    ...(stored ? { originalContentUrl: stored.url } : {}),
                },
                preview: `ファイル${message.fileName ? `（${message.fileName}）` : ''}が送信されました`,
            }
        }

        case 'location':
            return {
                contentType: 'location',
                content: {
                    type: 'location',
                    title: message.title,
                    address: message.address,
                    latitude: message.latitude,
                    longitude: message.longitude,
                },
                preview: `位置情報${message.title ? `（${message.title}）` : ''}が送信されました`,
            }

        default:
            // 未知のタイプでも元データは残しておく（後から表示に対応できるように）
            return {
                contentType: message.type || 'unknown',
                content: message as Record<string, unknown>,
                preview: 'メッセージが送信されました',
            }
    }
}

/**
 * こちらから送るメッセージのプレビューテキスト。
 * 友だちリストの「最後のメッセージ」表示に使う。
 */
export function summarizeOutgoing(block: Record<string, unknown> | null | undefined): string {
    if (!block) return 'メッセージを送信しました'

    const text = typeof block.text === 'string' ? block.text : ''
    const altText = typeof block.altText === 'string' ? block.altText : ''

    switch (block.type) {
        case 'text':
            return text || 'メッセージを送信しました'
        case 'image':
            return '画像を送信しました'
        case 'video':
            return '動画を送信しました'
        case 'audio':
            return '音声を送信しました'
        case 'sticker':
            return 'スタンプを送信しました'
        case 'flex':
        case 'template':
            return altText || 'リッチメッセージを送信しました'
        default:
            return 'メッセージを送信しました'
    }
}
