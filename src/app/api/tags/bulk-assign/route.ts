import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { processRichMenuSwitchOnTagAssign } from '@/lib/rich-menu'

/**
 * 複数ユーザーに複数タグを一括付与
 * POST /api/tags/bulk-assign
 * Body: { userIds: string[], tagIds: string[] }
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
        }

        const { userIds, tagIds } = await request.json()

        if (!userIds?.length || !tagIds?.length) {
            return NextResponse.json({ error: 'userIds と tagIds が必要です' }, { status: 400 })
        }

        // 全タグが認証ユーザーのチャンネルに属するか確認
        const { data: accessibleTags } = await supabase
            .from('tags')
            .select(`
                id,
                channels!inner (
                    channel_members!inner (
                        profile_id
                    )
                )
            `)
            .in('id', tagIds)
            .eq('channels.channel_members.profile_id', user.id)

        if (!accessibleTags || accessibleTags.length !== tagIds.length) {
            return NextResponse.json({ error: 'タグへのアクセス権限がありません' }, { status: 403 })
        }

        // タグを一括upsert
        const upsertData = (userIds as string[]).flatMap(userId =>
            (tagIds as string[]).map(tagId => ({
                line_user_id: userId,
                tag_id: tagId,
            }))
        )

        const { error } = await supabase
            .from('line_user_tags')
            .upsert(upsertData, { onConflict: 'line_user_id,tag_id' })

        if (error) throw error

        // リッチメニュー切り替え処理
        for (const userId of userIds as string[]) {
            for (const tagId of tagIds as string[]) {
                await processRichMenuSwitchOnTagAssign(userId, tagId)
            }
        }

        return NextResponse.json({ success: true, processed: userIds.length })
    } catch (error) {
        console.error('一括タグ付与エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
