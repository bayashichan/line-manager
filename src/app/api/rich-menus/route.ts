import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { isR2Configured, uploadToR2Server } from '@/lib/storage/r2'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { syncChannelRichMenus } from '@/lib/rich-menu/sync'

export const maxDuration = 60

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
            // 拡張子はファイル名ではなく実際のContent-Typeから決める。
            // 中身と食い違ったままLINEに転送するとAndroidで描画できなくなる
            const contentType = imageFile.type === 'image/png' ? 'image/png' : 'image/jpeg'
            const fileExt = contentType === 'image/png' ? 'png' : 'jpg'
            const fileName = `${Date.now()}.${fileExt}`
            const filePath = `rich-menus/${channelId}/${fileName}`

            const arrayBuffer = await imageFile.arrayBuffer()
            const buffer = new Uint8Array(arrayBuffer)

            if (!isR2Configured()) {
                return NextResponse.json(
                    { error: 'ファイル配信用のR2が未設定です（R2_* の環境変数を確認してください）' },
                    { status: 503 }
                )
            }

            try {
                imageUrl = await uploadToR2Server(filePath, buffer, contentType)
            } catch (uploadError) {
                console.error('リッチメニュー画像のアップロードに失敗:', uploadError)
                return NextResponse.json(
                    { error: '画像のアップロードに失敗しました' },
                    { status: 500 }
                )
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
 * リッチメニュー削除（LINE 上のメニューも消す）
 * DELETE /api/rich-menus?id=xxx
 *
 * 全員向けやタグに設定していた場合は、その設定も外して LINE の表示を揃え直す。
 */
export async function DELETE(request: NextRequest) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
    }

    const id = request.nextUrl.searchParams.get('id')
    if (!id) {
        return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
    }

    const admin = createAdminClient()
    const { data: richMenu } = await admin
        .from('rich_menus')
        .select('id, channel_id, rich_menu_id, channels!rich_menus_channel_id_fkey(channel_access_token)')
        .eq('id', id)
        .maybeSingle()

    if (!richMenu || !(await isChannelMember(user.id, richMenu.channel_id))) {
        return NextResponse.json({ error: 'リッチメニューが見つかりません' }, { status: 404 })
    }

    try {
        // DB から消す。タグの紐付け・基本のメニュー・各ユーザーの記録は外部キーで自動的に外れる
        const { error: deleteError } = await admin.from('rich_menus').delete().eq('id', id)
        if (deleteError) throw deleteError

        // 残った設定どおりに LINE を揃える（このメニューのタグだった人を次の候補へ付け替える）
        const warnings: string[] = []
        try {
            const result = await syncChannelRichMenus(richMenu.channel_id)
            warnings.push(...result.warnings)
        } catch (err) {
            console.error('削除後のリッチメニュー反映エラー:', err)
            warnings.push('LINEへの反映に失敗しました。「LINEと揃え直す」を押してください。')
        }

        if (richMenu.rich_menu_id) {
            const channel = richMenu.channels as unknown as { channel_access_token: string } | null
            if (channel?.channel_access_token) {
                const lineClient = new LineClient(channel.channel_access_token)
                // 全員向けに設定したまま消すと何も表示されなくなるため、先にデフォルトを外す
                const currentDefault = await lineClient.getDefaultRichMenuId().catch(() => null)
                if (currentDefault === richMenu.rich_menu_id) {
                    await lineClient.cancelDefaultRichMenu().catch(() => { })
                }
                await lineClient.deleteRichMenu(richMenu.rich_menu_id).catch(err => {
                    console.error('LINE上のリッチメニュー削除に失敗:', err)
                })
            }
        }

        return NextResponse.json({ success: true, warnings })
    } catch (error) {
        console.error('リッチメニュー削除エラー:', error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
