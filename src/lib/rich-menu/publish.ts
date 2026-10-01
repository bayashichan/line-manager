import type { LineClient } from '@/lib/line'
import type { RichMenuArea } from '@/types'
import { fitAreasToSize, normalizeRichMenuAreas } from './areas'
import {
    RICH_MENU_MAX_IMAGE_BYTES,
    detectImageMimeType,
    isAllowedRichMenuSize,
    readImageSize,
} from './image-size'

/** 画面にそのまま出せる理由付きの、LINE への反映失敗 */
export class RichMenuPublishError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RichMenuPublishError'
    }
}

export type PublishableRichMenu = {
    name: string
    image_url: string | null
    areas: RichMenuArea[] | null
}

/**
 * DB のリッチメニュー（画像・タップ領域）から LINE 上にリッチメニューを作る。
 *
 * LINE のリッチメニューは作成後に画像やタップ領域を変更できないため、
 * 内容を変えたときはこれで作り直し、ユーザーのリンクを付け替えてから古いものを消す。
 */
export async function createLineRichMenu(
    lineClient: LineClient,
    menu: PublishableRichMenu
): Promise<{ lineRichMenuId: string; skippedAreaNumbers: number[] }> {
    if (!menu.image_url) {
        throw new RichMenuPublishError('画像が設定されていません')
    }

    // タップ領域を正規化（アクション未入力のエリアは除外）
    // LINEは text/uri が空文字のアクションを受け付けず
    // `must be non-empty text` エラーになるため、ここで落とす
    const savedAreas = (menu.areas || []) as RichMenuArea[]
    const { areas: normalizedAreas, skippedAreaNumbers } = normalizeRichMenuAreas(savedAreas)

    if (savedAreas.length > 0 && normalizedAreas.length === 0) {
        throw new RichMenuPublishError(
            'タップ領域のアクションが未入力です。各エリアにメッセージ本文またはURLを入力して保存してください。'
        )
    }

    // 画像をダウンロード（サイズ判定にも使うため作成前に取得する）
    const imageResponse = await fetch(menu.image_url)

    if (!imageResponse.ok) {
        throw new RichMenuPublishError('画像の取得に失敗しました')
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer())

    // Content-Type ヘッダーは信用せず、中身のマジックナンバーでフォーマットを判定する。
    // ヘッダー（例: image/png）と中身（例: JPEG）が食い違ったままLINEに渡すと、
    // iOSは中身を見て描画するがAndroidは宣言どおりデコードしようとして失敗し、
    // リッチメニューが「読み込み中」のまま表示されなくなる。
    const contentType = detectImageMimeType(imageBuffer)

    if (!contentType) {
        throw new RichMenuPublishError(
            '画像がJPEG / PNGではありません。JPEGまたはPNGの画像を選び直して保存してください。'
        )
    }

    if (imageBuffer.byteLength > RICH_MENU_MAX_IMAGE_BYTES) {
        throw new RichMenuPublishError(
            `画像のファイルサイズが${Math.round(imageBuffer.byteLength / 1024)}KBあり、LINEの上限（1MB）を超えています。画像を選び直して保存してください。`
        )
    }

    const size = readImageSize(imageBuffer)

    if (!size || !isAllowedRichMenuSize(size)) {
        throw new RichMenuPublishError(
            '画像サイズがLINEの条件（幅800〜2500px・高さ250px以上・幅÷高さが1.45以上）を満たしていません。画像を選び直して保存してください。'
        )
    }

    // エリアが設定されていない場合はメニュー全体を1エリアとして扱う
    const richMenuAreas = normalizedAreas.length > 0 ? normalizedAreas : [
        {
            bounds: { x: 0, y: 0, width: size.width, height: size.height },
            action: { type: 'message', text: 'メニュー' },
        }
    ]

    // 画像サイズと座標系が食い違っていても登録できるよう、枠内に収まるよう補正する
    const fittedAreas = fitAreasToSize(richMenuAreas, size)

    const { richMenuId: lineRichMenuId } = await lineClient.createRichMenu({
        size,
        selected: true,
        // LINE の上限は300文字
        name: menu.name.slice(0, 300),
        chatBarText: 'メニュー',
        areas: fittedAreas,
    })

    try {
        await lineClient.uploadRichMenuImage(
            lineRichMenuId,
            new Blob([new Uint8Array(imageBuffer)], { type: contentType }),
            contentType
        )
    } catch (uploadError) {
        // 画像なしのリッチメニューが残ると端末側で「読み込み中」のままになるため、
        // アップロードに失敗した枠は作りっぱなしにせず消す
        await lineClient.deleteRichMenu(lineRichMenuId).catch(() => { })
        throw uploadError
    }

    return { lineRichMenuId, skippedAreaNumbers }
}
