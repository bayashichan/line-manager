/**
 * LINEが許可しているリッチメニューのサイズ
 * https://developers.line.biz/ja/reference/messaging-api/#rich-menu-size
 */
const ALLOWED_SIZES = [
    { width: 2500, height: 1686 },
    { width: 2500, height: 843 },
    { width: 1200, height: 810 },
    { width: 1200, height: 405 },
    { width: 800, height: 540 },
    { width: 800, height: 270 },
]

export const DEFAULT_RICH_MENU_SIZE = { width: 2500, height: 1686 }

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
 * 画像サイズからリッチメニューのサイズを決める。
 * LINEはリッチメニューのサイズと画像のサイズが一致していないと登録できないため、
 * 許可サイズに一致した場合のみ採用し、それ以外は従来通り 2500x1686 とする。
 */
export function resolveRichMenuSize(buffer: Buffer): { width: number; height: number } {
    const size = readImageSize(buffer)
    if (!size) return DEFAULT_RICH_MENU_SIZE

    const matched = ALLOWED_SIZES.find(s => s.width === size.width && s.height === size.height)
    return matched || DEFAULT_RICH_MENU_SIZE
}
