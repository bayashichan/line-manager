import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { saveRichMenuRules, syncChannelRichMenus } from '@/lib/rich-menu/sync'

export const dynamic = 'force-dynamic'
// 友だちが多いと LINE への一括送信に時間がかかるため長めに取る
export const maxDuration = 60

const id = z.string().min(1)

const bodySchema = z.object({
    channelId: id,
    /** 全員向け（基本）のメニュー。null で「なし」 */
    defaultMenuId: id.nullable().optional(),
    /** タグごとのメニュー。menuId が null でそのタグの紐付けを外す */
    tagMenus: z.array(z.object({ tagId: id, menuId: id.nullable() })).optional(),
    /** このメニューを使うタグ（編集画面からまとめて指定） */
    menuTags: z.object({ menuId: id, tagIds: z.array(id) }).optional(),
    /** 内容を編集したメニュー（LINE 上で作り直す） */
    editedMenuIds: z.array(id).optional(),
    /** 全員の個別設定を LINE に送り直す（既定: true） */
    force: z.boolean().optional(),
})

/**
 * リッチメニューの「誰に・どれを見せるか」を保存して、すぐ LINE に反映する
 * POST /api/rich-menus/apply
 *
 * 設定の変更がなくても呼べる（＝ LINE と揃え直す）。
 */
export async function POST(request: NextRequest) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
        return NextResponse.json({ error: 'リクエストの形式が正しくありません' }, { status: 400 })
    }

    const body = parsed.data

    if (!(await isChannelMember(user.id, body.channelId))) {
        return NextResponse.json({ error: 'このアカウントを操作する権限がありません' }, { status: 403 })
    }

    const admin = createAdminClient()

    // 指定されたメニュー・タグがこのチャンネルのものか確認する
    const menuIds = [
        body.defaultMenuId,
        ...(body.tagMenus ?? []).map(t => t.menuId),
        body.menuTags?.menuId,
        ...(body.editedMenuIds ?? []),
    ].filter((v): v is string => Boolean(v))
    const tagIds = [
        ...(body.tagMenus ?? []).map(t => t.tagId),
        ...(body.menuTags?.tagIds ?? []),
    ]

    if (menuIds.length > 0) {
        const unique = [...new Set(menuIds)]
        const { data } = await admin
            .from('rich_menus')
            .select('id')
            .eq('channel_id', body.channelId)
            .in('id', unique)
        if ((data ?? []).length !== unique.length) {
            return NextResponse.json({ error: 'リッチメニューが見つかりません' }, { status: 404 })
        }
    }

    if (tagIds.length > 0) {
        const unique = [...new Set(tagIds)]
        const { data } = await admin
            .from('tags')
            .select('id')
            .eq('channel_id', body.channelId)
            .in('id', unique)
        if ((data ?? []).length !== unique.length) {
            return NextResponse.json({ error: 'タグが見つかりません' }, { status: 404 })
        }
    }

    try {
        await saveRichMenuRules(admin, body.channelId, {
            defaultMenuId: body.defaultMenuId,
            tagMenus: body.tagMenus,
            menuTags: body.menuTags,
        })

        const result = await syncChannelRichMenus(body.channelId, {
            force: body.force ?? true,
            editedMenuIds: body.editedMenuIds,
        })

        return NextResponse.json({ success: true, ...result })
    } catch (error) {
        console.error('リッチメニュー反映エラー:', error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
