import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { processRichMenuSwitchOnTagAssign, processRichMenuSwitchOnTagRemove } from '@/lib/rich-menu'

/**
 * タグをユーザーに付与
 * POST /api/tags/assign
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const { lineUserId, tagId } = await request.json()

        if (!lineUserId || !tagId) {
            return NextResponse.json(
                { error: 'lineUserId と tagId が必要です' },
                { status: 400 }
            )
        }

        // ユーザーがこのタグにアクセス権限があるか確認
        const { data: tag, error: tagError } = await supabase
            .from('tags')
            .select(`
        id,
        channel_id,
        channels!inner (
          channel_members!inner (
            profile_id
          )
        )
      `)
            .eq('id', tagId)
            .eq('channels.channel_members.profile_id', user.id)
            .single()

        if (tagError || !tag) {
            return NextResponse.json({ error: 'タグが見つかりません' }, { status: 404 })
        }

        // タグを付与
        const { error: assignError } = await supabase
            .from('line_user_tags')
            .insert({
                line_user_id: lineUserId,
                tag_id: tagId,
            })

        if (assignError) {
            if (assignError.code === '23505') {
                return NextResponse.json(
                    { error: 'このタグは既に付与されています' },
                    { status: 409 }
                )
            }
            throw assignError
        }

        // リッチメニュー切り替え処理を実行
        await processRichMenuSwitchOnTagAssign(lineUserId, tagId)

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('タグ付与エラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}

/**
 * タグをユーザーから解除
 * DELETE /api/tags/assign
 */
export async function DELETE(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const { lineUserId, tagId } = await request.json()

        if (!lineUserId || !tagId) {
            return NextResponse.json(
                { error: 'lineUserId と tagId が必要です' },
                { status: 400 }
            )
        }

        // タグを解除
        const { error: deleteError } = await supabase
            .from('line_user_tags')
            .delete()
            .eq('line_user_id', lineUserId)
            .eq('tag_id', tagId)

        if (deleteError) {
            throw deleteError
        }

        // リッチメニュー切り替え処理を実行
        await processRichMenuSwitchOnTagRemove(lineUserId)

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('タグ解除エラー:', error)
        return NextResponse.json(
            { error: '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
