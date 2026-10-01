import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncChannelRichMenus } from '@/lib/rich-menu/sync'

export const maxDuration = 60

/**
 * タグとリッチメニューの紐付け・優先度を変えたときに、すでにそのタグが付いている人へ反映する。
 * 失敗してもタグの保存自体は成功しているので、エラーにはしない。
 */
async function applyRichMenusForTagChange(channelId: string): Promise<void> {
    try {
        const result = await syncChannelRichMenus(channelId)
        if (result.warnings.length > 0) console.warn('タグ変更後のリッチメニュー反映:', result.warnings)
    } catch (err) {
        console.error('タグ変更後のリッチメニュー反映エラー:', err)
    }
}

/**
 * タグ一覧取得
 * GET /api/tags?channelId=xxx
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
            return NextResponse.json(
                { error: 'channelId が必要です' },
                { status: 400 }
            )
        }

        const { data: tags, error } = await supabase
            .from('tags')
            .select(`
        *,
        rich_menus (
          id,
          name,
          rich_menu_id
        )
      `)
            .eq('channel_id', channelId)
            .order('priority', { ascending: false })
            .order('name')

        if (error) {
            throw error
        }

        return NextResponse.json(tags)
    } catch (error) {
        console.error('タグ取得エラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}

/**
 * タグ作成
 * POST /api/tags
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const body = await request.json()
        const { channelId, name, color, linkedRichMenuId, priority } = body

        if (!channelId || !name) {
            return NextResponse.json(
                { error: 'channelId と name が必要です' },
                { status: 400 }
            )
        }

        // アクセス権限確認
        const { data: member } = await supabase
            .from('channel_members')
            .select('id')
            .eq('channel_id', channelId)
            .eq('profile_id', user.id)
            .single()

        if (!member) {
            return NextResponse.json({ error: 'アクセス権限がありません' }, { status: 403 })
        }

        const { data: tag, error } = await supabase
            .from('tags')
            .insert({
                channel_id: channelId,
                name,
                color: color || '#3B82F6',
                linked_rich_menu_id: linkedRichMenuId || null,
                priority: priority || 0,
            })
            .select()
            .single()

        if (error) {
            if (error.code === '23505') {
                return NextResponse.json(
                    { error: '同じ名前のタグが既に存在します' },
                    { status: 409 }
                )
            }
            throw error
        }

        // 紐付けたメニューを LINE に反映しておく（このタグを付けた人にすぐ表示できるように）
        if (tag.linked_rich_menu_id) {
            await applyRichMenusForTagChange(channelId)
        }

        return NextResponse.json(tag)
    } catch (error) {
        console.error('タグ作成エラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}

/**
 * タグ更新
 * PATCH /api/tags
 */
export async function PATCH(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const body = await request.json()
        const { id, name, color, linkedRichMenuId, priority } = body

        if (!id) {
            return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
        }

        const { data: before } = await supabase
            .from('tags')
            .select('linked_rich_menu_id, priority')
            .eq('id', id)
            .maybeSingle()

        const updateData: Record<string, any> = {}
        if (name !== undefined) updateData.name = name
        if (color !== undefined) updateData.color = color
        if (linkedRichMenuId !== undefined) updateData.linked_rich_menu_id = linkedRichMenuId
        if (priority !== undefined) updateData.priority = priority

        const { data: tag, error } = await supabase
            .from('tags')
            .update(updateData)
            .eq('id', id)
            .select()
            .single()

        if (error) {
            throw error
        }

        // 紐付けるメニューや優先度が変わったら、このタグがすでに付いている人にも反映する
        const richMenuChanged =
            !before ||
            before.linked_rich_menu_id !== tag.linked_rich_menu_id ||
            ((before.linked_rich_menu_id || tag.linked_rich_menu_id) && before.priority !== tag.priority)
        if (richMenuChanged) {
            await applyRichMenusForTagChange(tag.channel_id)
        }

        return NextResponse.json(tag)
    } catch (error) {
        console.error('タグ更新エラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}

/**
 * タグ削除
 * DELETE /api/tags?id=xxx
 */
export async function DELETE(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const id = request.nextUrl.searchParams.get('id')

        if (!id) {
            return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
        }

        const { data: before } = await supabase
            .from('tags')
            .select('channel_id, linked_rich_menu_id')
            .eq('id', id)
            .maybeSingle()

        const { error } = await supabase
            .from('tags')
            .delete()
            .eq('id', id)

        if (error) {
            throw error
        }

        // メニューが紐付いたタグだったら、付いていた人を次の候補（なければ全員向け）へ戻す
        if (before?.linked_rich_menu_id) {
            await applyRichMenusForTagChange(before.channel_id)
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('タグ削除エラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
