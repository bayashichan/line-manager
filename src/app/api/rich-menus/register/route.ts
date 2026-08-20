import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { fitAreasToSize, normalizeRichMenuAreas } from '@/lib/rich-menu/areas'
import { resolveRichMenuSize } from '@/lib/rich-menu/image-size'
import type { RichMenuArea } from '@/types'

/**
 * リッチメニューをLINE APIに登録
 * POST /api/rich-menus/register
 * 
 * リクエストボディ:
 * - richMenuId: DBのリッチメニューID
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const { richMenuId } = await request.json()

        if (!richMenuId) {
            return NextResponse.json({ error: 'richMenuId が必要です' }, { status: 400 })
        }

        // リッチメニュー情報取得
        const adminClient = createAdminClient()
        const { data: richMenu, error: menuError } = await adminClient
            .from('rich_menus')
            .select(`
        *,
        channels!rich_menus_channel_id_fkey (*)
      `)
            .eq('id', richMenuId)
            .single()

        if (menuError || !richMenu) {
            console.error('RichMenu fetch error:', menuError, 'ID:', richMenuId)
            return NextResponse.json({
                error: 'リッチメニューが見つかりません',
                details: {
                    id: richMenuId,
                    dbError: menuError
                }
            }, { status: 404 })
        }

        if (!richMenu.image_url) {
            return NextResponse.json({ error: '画像が設定されていません' }, { status: 400 })
        }

        const channel = richMenu.channels as any
        const lineClient = new LineClient(channel.channel_access_token)

        // タップ領域を正規化（アクション未入力のエリアは除外）
        // LINEは text/uri が空文字のアクションを受け付けず
        // `must be non-empty text` エラーになるため、ここで落とす
        const savedAreas = (richMenu.areas || []) as RichMenuArea[]
        const { areas: normalizedAreas, skippedAreaNumbers } = normalizeRichMenuAreas(savedAreas)

        if (savedAreas.length > 0 && normalizedAreas.length === 0) {
            return NextResponse.json({
                error: 'タップ領域のアクションが未入力です。各エリアにメッセージ本文またはURLを入力し、保存してから登録してください。',
            }, { status: 400 })
        }

        // 1. 画像をダウンロード（サイズ判定にも使うため作成前に取得する）
        const imageResponse = await fetch(richMenu.image_url)

        if (!imageResponse.ok) {
            return NextResponse.json({ error: '画像の取得に失敗しました' }, { status: 400 })
        }

        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer())
        const contentType = imageResponse.headers.get('content-type') || 'image/png'
        const size = resolveRichMenuSize(imageBuffer)

        // エリアが設定されていない場合はメニュー全体を1エリアとして扱う
        const richMenuAreas = normalizedAreas.length > 0 ? normalizedAreas : [
            {
                bounds: { x: 0, y: 0, width: size.width, height: size.height },
                action: { type: 'message', text: 'メニュー' },
            }
        ]

        // 画像サイズと座標系が食い違っていても登録できるよう、枠内に収まるよう補正する
        const fittedAreas = fitAreasToSize(richMenuAreas, size)

        const richMenuObject = {
            size,
            selected: true,
            name: richMenu.name,
            chatBarText: 'メニュー',
            areas: fittedAreas,
        }

        // 2. リッチメニューを作成して画像をアップロード
        const { richMenuId: lineRichMenuId } = await lineClient.createRichMenu(richMenuObject)

        await lineClient.uploadRichMenuImage(
            lineRichMenuId,
            new Blob([new Uint8Array(imageBuffer)], { type: contentType }),
            contentType
        )

        // 3. DBを更新
        await adminClient
            .from('rich_menus')
            .update({ rich_menu_id: lineRichMenuId })
            .eq('id', richMenuId)

        // 4. デフォルトメニューの場合、全ユーザーに適用
        if (richMenu.is_default) {
            await lineClient.setDefaultRichMenu(lineRichMenuId)

            // チャンネルのデフォルトリッチメニューIDを更新
            await adminClient
                .from('channels')
                .update({ default_rich_menu_id: richMenuId })
                .eq('id', channel.id)
        }

        // 5. 表示期間が設定されていて、現在が期間内であれば即座に適用
        const now = new Date()
        const periodStart = richMenu.display_period_start ? new Date(richMenu.display_period_start) : null
        const periodEnd = richMenu.display_period_end ? new Date(richMenu.display_period_end) : null

        if (periodStart && periodEnd && now >= periodStart && now <= periodEnd) {
            try {
                await lineClient.setDefaultRichMenu(lineRichMenuId)

                // is_active フラグを立てる
                await adminClient
                    .from('rich_menus')
                    .update({ is_active: true })
                    .eq('id', richMenuId)

                console.log(`表示期間内のため即座に適用: ${richMenu.name}`)
            } catch (err) {
                console.error('期間メニュー即時適用エラー:', err)
                // 適用失敗してもメニュー作成自体は成功なので続行
            }
        }

        return NextResponse.json({
            success: true,
            lineRichMenuId,
            skippedAreaNumbers,
        })
    } catch (error) {
        console.error('LINE API登録エラー:', error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '内部サーバーエラー' },
            { status: 500 }
        )
    }
}

/**
 * LINE APIからリッチメニューを削除
 * DELETE /api/rich-menus/register?richMenuId=xxx
 */
export async function DELETE(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const richMenuId = request.nextUrl.searchParams.get('richMenuId')

        if (!richMenuId) {
            return NextResponse.json({ error: 'richMenuId が必要です' }, { status: 400 })
        }

        // リッチメニュー情報取得
        const adminClient = createAdminClient()
        const { data: richMenu, error: menuError } = await adminClient
            .from('rich_menus')
            .select(`
        *,
        channels!rich_menus_channel_id_fkey (*)
      `)
            .eq('id', richMenuId)
            .single()

        if (menuError || !richMenu) {
            return NextResponse.json({ error: 'リッチメニューが見つかりません' }, { status: 404 })
        }

        if (!richMenu.rich_menu_id) {
            return NextResponse.json({ error: 'LINE APIに登録されていません' }, { status: 400 })
        }

        const channel = richMenu.channels as any
        const lineClient = new LineClient(channel.channel_access_token)

        // LINE APIからリッチメニューを削除
        await lineClient.deleteRichMenu(richMenu.rich_menu_id)

        // DBを更新
        await adminClient
            .from('rich_menus')
            .update({ rich_menu_id: null })
            .eq('id', richMenuId)

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('LINE API削除エラー:', error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
