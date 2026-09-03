/**
 * 管理画面で作ったブロック（content JSONB）を、LINE Messaging API が受け付ける
 * メッセージオブジェクトへ変換する。
 *
 * 一斉配信・予約配信・ステップ配信・テスト送信で同じ変換を使うためにここへ集約している。
 * 以前は各ルートに同じ変換がコピーされており、予約配信(cron)だけ変換が抜けていた。
 *
 * LINE側のバリデーションは厳しく、1つでも不正な値があるとリクエスト全体が400で落ちる。
 * = 配信そのものが「失敗」になるため、送る前にここで弾いて理由を返す。
 */

import { MAX_TEXT_LENGTH } from './auto-reply'

/** LINE Messaging API に渡すメッセージオブジェクト */
export type LineMessage = Record<string, any>

/** LINEに渡す前に検出した不正内容。送信は行わず、この理由を配信履歴に残す */
export class LineContentError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'LineContentError'
    }
}

/**
 * Flex Message の image は aspectRatio を "{width}:{height}" で指定する。
 * width / height に指定できるのは 1〜100000 で、height に width の3倍を超える値は指定できない。
 *
 * 旧実装は `${width / height}:1` を組み立てていたため、
 * 縦長画像（例: 1040x2080 → "0.5:1"）だと width が 1 未満になり LINE に拒否されていた。
 */
const ASPECT_DENOMINATOR = 1000
const ASPECT_MAX = 100000

type AspectSpec = { aspectRatio?: string; aspectMode: 'cover' | 'fit' }

/**
 * 横縦比（width / height）を LINE が受け付ける "{width}:{height}" 表記へ変換する。
 * 3倍を超える縦長は LINE の仕様上そのまま表示できないため、1:3 に収めた上で
 * 見切れないよう aspectMode を fit にする。
 */
export function toFlexAspectRatio(ratio: unknown): AspectSpec {
    const value = typeof ratio === 'number' ? ratio : Number(ratio)

    // 未指定・不正値は指定しない（LINEの既定値 1:1 になる）
    if (!Number.isFinite(value) || value <= 0) {
        return { aspectMode: 'cover' }
    }

    const width = Math.round(value * ASPECT_DENOMINATOR)

    // height(=1000) が width の3倍を超えてしまう縦長
    if (width * 3 < ASPECT_DENOMINATOR) {
        return { aspectRatio: '1:3', aspectMode: 'fit' }
    }

    // 横に極端に長い場合は width が上限を超えるので丸める
    if (width > ASPECT_MAX) {
        return { aspectRatio: `${ASPECT_MAX}:${ASPECT_DENOMINATOR}`, aspectMode: 'cover' }
    }

    return { aspectRatio: `${width}:${ASPECT_DENOMINATOR}`, aspectMode: 'cover' }
}

/**
 * 画像・動画のURLを検証する。LINEは https のみ受け付ける（http や相対URLは400）。
 */
function requireHttpsUrl(raw: unknown, label: string): string {
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new LineContentError(`${label}が設定されていません`)
    }

    const value = raw.trim()
    let parsed: URL
    try {
        parsed = new URL(value)
    } catch {
        throw new LineContentError(`${label}が正しいURLではありません: ${value}`)
    }

    if (parsed.protocol !== 'https:') {
        throw new LineContentError(`${label}は https から始まるURLである必要があります: ${value}`)
    }

    return value
}

/**
 * タップ時に開くURLを検証する。
 * スキームなし（例: example.com）はブラウザでは補完されるが LINE では400になるため、
 * https:// を補って救済する。
 */
export function normalizeActionUri(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new LineContentError('遷移先URLが設定されていません')
    }

    const value = raw.trim()
    const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) ? value : `https://${value}`

    let parsed: URL
    try {
        parsed = new URL(candidate)
    } catch {
        throw new LineContentError(`遷移先URLが正しいURLではありません: ${value}`)
    }

    // LINEのURIアクションで許可されているスキーム
    const allowed = ['http:', 'https:', 'tel:', 'line:']
    if (!allowed.includes(parsed.protocol)) {
        throw new LineContentError(
            `遷移先URLには http / https / tel / line のいずれかのURLを指定してください: ${value}`
        )
    }

    return candidate
}

type BuildOptions = {
    /**
     * URL遷移以外のアクション（タグ付与・ステップ配信・自動返信）を postback で受けるためのデータ。
     * 呼び出し元でメッセージIDやシナリオIDを埋める。
     */
    postbackData?: string
}

function buildImageAction(block: any, options: BuildOptions): LineMessage | null {
    if (block.customActions) {
        const { redirectUrl, tagIds, scenarioId, replyText } = block.customActions

        if (redirectUrl) {
            return { type: 'uri', uri: normalizeActionUri(redirectUrl) }
        }

        // URL以外のアクションはpostbackイベントで処理する
        const hasOtherAction =
            (Array.isArray(tagIds) && tagIds.length > 0) || !!scenarioId || !!replyText

        if (hasOtherAction) {
            if (!options.postbackData) {
                throw new LineContentError('画像アクションの受け口が設定されていません')
            }
            return { type: 'postback', data: options.postbackData }
        }

        // customActions は空。アクションなしの通常画像として扱う
        return null
    }

    // 旧仕様互換
    if (block.linkUrl) {
        return { type: 'uri', uri: normalizeActionUri(block.linkUrl) }
    }

    return null
}

/**
 * アクション付き画像は image メッセージでは表現できないため Flex Message にする。
 */
function buildImageFlexMessage(block: any, action: LineMessage): LineMessage {
    const url = requireHttpsUrl(block.originalContentUrl || block.previewImageUrl, '画像のURL')
    const { aspectRatio, aspectMode } = toFlexAspectRatio(block.aspectRatio)

    const image: Record<string, unknown> = {
        type: 'image',
        url,
        size: 'full',
        aspectMode,
        action,
    }

    // undefined のキーはLINEに送らない（Flexは未知/不正な値に厳しい）
    if (aspectRatio) {
        image.aspectRatio = aspectRatio
    }

    return {
        type: 'flex',
        altText: '画像メッセージ',
        contents: {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                contents: [image],
                paddingAll: '0px',
            },
        },
    }
}

/**
 * content(ブロック配列) を LINE のメッセージ配列へ変換する。
 *
 * customActions / aspectRatio / imageType などの管理画面用フィールドはここで落とす。
 * これらは LINE のメッセージオブジェクトには存在しないプロパティのため、
 * そのまま送るとアクションが失われたり、リクエストが弾かれたりする。
 */
export function buildLineMessages(content: unknown, options: BuildOptions = {}): LineMessage[] {
    const blocks = Array.isArray(content) ? content : [content]

    if (blocks.length === 0) {
        throw new LineContentError('配信内容が空です')
    }

    return blocks.map((block: any, index: number) => {
        if (!block || typeof block !== 'object') {
            throw new LineContentError(`${index + 1}番目のブロックが不正です`)
        }

        switch (block.type) {
            case 'text': {
                const text = typeof block.text === 'string' ? block.text : ''
                if (text.trim() === '') {
                    throw new LineContentError(`${index + 1}番目のテキストが空です`)
                }
                if (text.length > MAX_TEXT_LENGTH) {
                    throw new LineContentError(
                        `${index + 1}番目のテキストが${MAX_TEXT_LENGTH}文字を超えています`
                    )
                }
                return { type: 'text', text }
            }

            case 'image': {
                const action = buildImageAction(block, options)
                if (action) {
                    return buildImageFlexMessage(block, action)
                }

                const url = requireHttpsUrl(
                    block.originalContentUrl || block.previewImageUrl,
                    '画像のURL'
                )
                return {
                    type: 'image',
                    originalContentUrl: url,
                    previewImageUrl: requireHttpsUrl(
                        block.previewImageUrl || block.originalContentUrl,
                        '画像のURL'
                    ),
                }
            }

            case 'video': {
                const url = requireHttpsUrl(block.originalContentUrl, '動画のURL')
                return {
                    type: 'video',
                    originalContentUrl: url,
                    previewImageUrl: requireHttpsUrl(
                        block.previewImageUrl || block.originalContentUrl,
                        'サムネイル画像のURL'
                    ),
                }
            }

            // すでにLINE形式で組み立て済みのもの（Flexなど）はそのまま通す
            case 'flex':
            case 'template':
            case 'sticker':
            case 'location':
                return block

            default:
                throw new LineContentError(`未対応のメッセージ種別です: ${block.type}`)
        }
    })
}

/**
 * メッセージ配列の {name} を表示名へ置き換える（テキストのみ）。
 */
export function replaceNamePlaceholder(
    messages: LineMessage[],
    displayName: string | null | undefined
): LineMessage[] {
    const name = displayName || '友だち'
    return messages.map((message) =>
        message.type === 'text' && typeof message.text === 'string'
            ? { ...message, text: message.text.replace(/{name}/g, name) }
            : message
    )
}

/**
 * {name} を含むかどうか（含む場合は個別送信に切り替える）。
 */
export function hasNamePlaceholder(messages: LineMessage[]): boolean {
    return messages.some(
        (message) => message.type === 'text' && message.text?.includes('{name}')
    )
}

/**
 * LINE APIのエラーを配信履歴に残せる長さの文字列にする。
 */
export function toErrorMessage(error: unknown, max = 1000): string {
    const raw =
        error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
    return raw.length > max ? `${raw.slice(0, max)}…` : raw
}
