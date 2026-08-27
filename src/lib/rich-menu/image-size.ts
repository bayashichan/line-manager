/**
 * リッチメニュー画像に対するLINE側の制約
 * https://developers.line.biz/ja/reference/messaging-api/#upload-rich-menu-image
 *
 * - フォーマット: JPEG または PNG
 * - 幅: 800〜2500px / 高さ: 250px以上 / アスペクト比(幅÷高さ): 1.45以上
 * - ファイルサイズ: 1MB以下
 */
const MIN_WIDTH = 800
const MAX_WIDTH = 2500
const MIN_HEIGHT = 250
const MIN_ASPECT_RATIO = 1.45

export const RICH_MENU_MAX_IMAGE_BYTES = 1024 * 1024

/**
 * PNG / JPEG のバイナリから画像サイズを読み取る。
 * 読み取れない場合は null を返す。
 */
export function readImageSize(buffer: Buffer): { width: number; height: number } | null {
    // PNG: 8バイトのシグネチャ + IHDRチャンク（幅・高さは16バイト目から）
    if (
        buffer.length >= 24 &&
        buffer.readUInt32BE(0) === 0x89504e47 &&
        buffer.readUInt32BE(4) === 0x0d0a1a0a
    ) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }

    // JPEG: SOF0〜SOF15 マーカーを走査する
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) {
                offset++
                continue
            }
            const marker = buffer[offset + 1]
            // スタンドアロンマーカー（長さフィールドを持たない）
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                offset += 2
                continue
            }
            const length = buffer.readUInt16BE(offset + 2)
            const isSOF =
                marker >= 0xc0 && marker <= 0xcf &&
                marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
            if (isSOF) {
                return {
                    height: buffer.readUInt16BE(offset + 5),
                    width: buffer.readUInt16BE(offset + 7),
                }
            }
            offset += 2 + length
        }
    }

    return null
}

/**
 * PNG / JPEG のバイナリから実際のフォーマットを判定する。
 *
 * Content-Type ヘッダーではなく中身のマジックナンバーで判定するのが重要。
 * ヘッダーと中身が食い違ったままLINEにアップロードすると、
 * iOSは中身を見て描画できるがAndroidは宣言されたフォーマットで
 * デコードしようとして失敗し、リッチメニューが「読み込み中」のままになる。
 */
export function detectImageMimeType(buffer: Buffer): 'image/png' | 'image/jpeg' | null {
    if (
        buffer.length >= 8 &&
        buffer.readUInt32BE(0) === 0x89504e47 &&
        buffer.readUInt32BE(4) === 0x0d0a1a0a
    ) {
        return 'image/png'
    }

    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg'
    }

    return null
}

/**
 * LINEがリッチメニューとして受け付けるサイズかどうか
 */
export function isAllowedRichMenuSize(size: { width: number; height: number }): boolean {
    return (
        size.width >= MIN_WIDTH &&
        size.width <= MAX_WIDTH &&
        size.height >= MIN_HEIGHT &&
        size.width / size.height >= MIN_ASPECT_RATIO
    )
}
