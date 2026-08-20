import type { RichMenuArea } from '@/types'

/**
 * LINE APIに送信できる形に正規化したタップ領域
 */
export type NormalizedRichMenuArea = {
    bounds: { x: number; y: number; width: number; height: number }
    action: Record<string, string>
}

/**
 * アクションの入力値（メッセージ本文 / URL / postbackデータ）を取り出す
 */
export function getAreaActionValue(area: RichMenuArea | undefined): string {
    if (!area?.action) return ''
    switch (area.action.type) {
        case 'uri':
            return (area.action.uri || '').trim()
        case 'postback':
            return (area.action.data || '').trim()
        default:
            // メッセージ本文は改行や前後の空白も意味を持ちうるが、
            // 空白のみの入力はLINE側で「must be non-empty text」となるため未設定扱いにする
            return (area.action.text || '').trim()
    }
}

/**
 * アクションが設定済みか（テンプレート初期状態の空エリアでないか）
 */
export function isAreaConfigured(area: RichMenuArea | undefined): boolean {
    return !!area?.bounds && getAreaActionValue(area) !== ''
}

/**
 * タップ領域をLINE APIの仕様に合わせて正規化する。
 *
 * - アクション未入力のエリア（テンプレートのまま触っていない枠）は除外する
 *   LINEは空文字のtext/uriを受け付けず `must be non-empty text` エラーになるため
 * - アクション種別に応じて不要なプロパティ（message なのに uri など）を落とす
 */
export function normalizeRichMenuAreas(areas: RichMenuArea[] | null | undefined): {
    areas: NormalizedRichMenuArea[]
    skippedAreaNumbers: number[]
} {
    const normalized: NormalizedRichMenuArea[] = []
    const skippedAreaNumbers: number[] = []

    ;(areas || []).forEach((area, index) => {
        const value = getAreaActionValue(area)

        if (!area?.bounds || !value) {
            skippedAreaNumbers.push(index + 1)
            return
        }

        const type = area.action.type === 'uri' || area.action.type === 'postback'
            ? area.action.type
            : 'message'

        const action: Record<string, string> =
            type === 'uri' ? { type, uri: value }
                : type === 'postback' ? { type, data: value }
                    : { type, text: area.action.text as string }

        const label = (area.action.label || '').trim()
        if (label) action.label = label

        normalized.push({
            bounds: {
                x: Math.round(Number(area.bounds.x) || 0),
                y: Math.round(Number(area.bounds.y) || 0),
                width: Math.round(Number(area.bounds.width) || 0),
                height: Math.round(Number(area.bounds.height) || 0),
            },
            action,
        })
    })

    return { areas: normalized, skippedAreaNumbers }
}

/**
 * タップ領域をメニューのサイズに収める。
 *
 * 画像のサイズ（＝メニューのサイズ）と、保存済みの座標が想定していたサイズが
 * 食い違うと LINE 側で弾かれるため、はみ出している場合は比率を保ったまま縮小し、
 * 端数は枠内にクランプする。
 */
export function fitAreasToSize(
    areas: NormalizedRichMenuArea[],
    size: { width: number; height: number }
): NormalizedRichMenuArea[] {
    if (areas.length === 0) return areas

    const maxRight = Math.max(...areas.map(a => a.bounds.x + a.bounds.width))
    const maxBottom = Math.max(...areas.map(a => a.bounds.y + a.bounds.height))

    const scaleX = maxRight > size.width ? size.width / maxRight : 1
    const scaleY = maxBottom > size.height ? size.height / maxBottom : 1

    return areas.map(area => {
        // 各辺を換算してから幅・高さを求める（幅や高さを直接丸めると隙間やはみ出しが出る）
        const x = Math.min(Math.round(area.bounds.x * scaleX), size.width - 1)
        const y = Math.min(Math.round(area.bounds.y * scaleY), size.height - 1)
        const right = Math.min(Math.round((area.bounds.x + area.bounds.width) * scaleX), size.width)
        const bottom = Math.min(Math.round((area.bounds.y + area.bounds.height) * scaleY), size.height)

        return {
            ...area,
            bounds: {
                x,
                y,
                width: Math.max(1, right - x),
                height: Math.max(1, bottom - y),
            },
        }
    })
}
