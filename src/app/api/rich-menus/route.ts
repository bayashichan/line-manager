import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'

/**
 * リッチメニュー一覧取得
 * GET /api/rich-menus?channelId=xxx
 */
export async function GET(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const channelId = request.nextUrl.searchParams.get('channelId')

        if (!channelId) {
            return NextResponse.json({ error: 'channelId が必要です' }, { status: 400 })
        }

        const { data: richMenus, error } = await supabase
            .from('rich_menus')
            .select('*')
            .eq('channel_id', channelId)
            .order('is_default', { ascending: false })
            .order('name')

        if (error) throw error

        return NextResponse.json(richMenus)
    } catch (error) {
        console.error('リッチメニュー取得エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}

/**
 * リッチメニュー作成
 * POST /api/rich-menus
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const formData = await request.formData()
        const channelId = formData.get('channelId') as string
        const name = formData.get('name') as string
        const isDefault = formData.get('isDefault') === 'true'
        const areas = JSON.parse(formData.get('areas') as string || '[]')
        const imageFile = formData.get('image') as File | null

        if (!channelId || !name) {
            return NextResponse.json(
                { error: 'channelId と name が必要です' },
                { status: 400 }
            )
        }

        let imageUrl: string | null = null

        // 画像アップロード
        if (imageFile) {
            const fileExt = imageFile.name.split('.').pop()
            const fileName = `${Date.now()}.${fileExt}`
            const filePath = `rich-menus/${channelId}/${fileName}`

            const arrayBuffer = await imageFile.arrayBuffer()
            const buffer = new Uint8Array(arrayBuffer)

            const { error: uploadError } = await supabase.storage
                .from('line-assets')
                .upload(filePath, buffer, {
                    contentType: imageFile.type,
                })

            if (!uploadError) {
                const { data: { publicUrl } } = supabase.storage
                    .from('line-assets')
                    .getPublicUrl(filePath)
                imageUrl = publicUrl
            }
        }

        // デフォルト設定の場合、他のメニューのデフォルトを解除
        if (isDefault) {
            await supabase
                .from('rich_menus')
                .update({ is_default: false })
                .eq('channel_id', channelId)
        }

        const { data: richMenu, error } = await supabase
            .from('rich_menus')
            .insert({
                channel_id: channelId,
                name,
                image_url: imageUrl,
                areas,
                is_default: isDefault,
                is_active: true,
            })
            .select()
            .single()

        if (error) throw error

        return NextResponse.json(richMenu)
    } catch (error) {
        console.error('リッチメニュー作成エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}

/**
 * リッチメニューをLINE APIに登録
 * POST /api/rich-menus/register
 */
export async function registerToLine(request: NextRequest) {
    // この関数は別ルートで実装
}
