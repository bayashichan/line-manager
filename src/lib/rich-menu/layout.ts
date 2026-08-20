import type { RichMenuArea } from '@/types'

// リッチメニューのサイズ（LINE仕様）
export const MENU_WIDTH = 2500
export const MENU_HEIGHT_LARGE = 1686
export const MENU_HEIGHT_SMALL = 843

// タップ領域の最小サイズ（これ未満のドラッグは誤操作とみなす）
export const MIN_AREA_SIZE = 100

export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/** total を n 等分する（端数は最後の要素に寄せる） */
const splitEvenly = (total: number, n: number): number[] => {
    const base = Math.floor(total / n)
    return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - base * (n - 1) : base))
}

/** 段ごとの分割数からタップ領域を生成する（例: [3, 3] = 上段3個・下段3個） */
export const buildAreasFromLayout = (rows: number[], menuHeight: number): RichMenuArea[] => {
    const heights = splitEvenly(menuHeight, rows.length)
    const areas: RichMenuArea[] = []
    let y = 0

    rows.forEach((cols, rowIndex) => {
        let x = 0
        splitEvenly(MENU_WIDTH, cols).forEach(width => {
            areas.push({
                bounds: { x, y, width, height: heights[rowIndex] },
                action: { type: 'message', text: '' },
            })
            x += width
        })
        y += heights[rowIndex]
    })

    return areas
}

/** メニューの高さを変えたときに、タップ領域を比率を保ったまま追従させる */
export const rescaleAreas = (areas: RichMenuArea[], fromHeight: number, toHeight: number): RichMenuArea[] => {
    if (fromHeight === toHeight) return areas
    const ratio = toHeight / fromHeight

    return areas.map(area => {
        // 上端・下端をそれぞれ換算してから高さを求める。
        // 高さを直接丸めると 1px はみ出したり隙間ができたりするため
        const top = Math.min(Math.round(area.bounds.y * ratio), toHeight - 1)
        const bottom = Math.min(Math.round((area.bounds.y + area.bounds.height) * ratio), toHeight)

        return {
            ...area,
            bounds: {
                x: area.bounds.x,
                y: top,
                width: area.bounds.width,
                height: Math.max(1, bottom - top),
            },
        }
    })
}
