import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'

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

        // LINE APIにリッチメニューを作成
        const areas = (richMenu.areas || []) as any[]

        // エリアが設定されていない場合はデフォルトのエリアを設定
        const richMenuAreas = areas.length > 0 ? areas : [
            {
                bounds: { x: 0, y: 0, width: 2500, height: 1686 },
                action: { type: 'message', text: 'メニュー' }
            }
        ]

        const richMenuObject = {
            size: { width: 2500, height: 1686 },
            selected: true,
            name: richMenu.name,
            chatBarText: 'メニュー',
            areas: richMenuAreas.map((area: any) => ({
                bounds: area.bounds,
                action: area.action,
            })),
        }

        // 1. リッチメニューを作成
        const { richMenuId: lineRichMenuId } = await lineClient.createRichMenu(richMenuObject)

        // 2. 画像をダウンロードしてアップロード
        const imageResponse = await fetch(richMenu.image_url)
        const imageBlob = await imageResponse.blob()
        const contentType = imageResponse.headers.get('content-type') || 'image/png'

        await lineClient.uploadRichMenuImage(lineRichMenuId, imageBlob, contentType)

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
