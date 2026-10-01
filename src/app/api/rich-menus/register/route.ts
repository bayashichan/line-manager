import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, isChannelMember } from '@/lib/auth/channel-access'
import { LineClient } from '@/lib/line'
import { hasUpcomingDisplayPeriod } from '@/lib/rich-menu/plan'
import { syncChannelRichMenus } from '@/lib/rich-menu/sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function loadMenuForMember(richMenuId: string) {
    const user = await getSessionUser()
    if (!user) {
        return { error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }) }
    }

    const admin = createAdminClient()
    const { data: richMenu } = await admin
        .from('rich_menus')
        .select('id, channel_id, name, rich_menu_id, is_default, display_period_start, display_period_end')
        .eq('id', richMenuId)
        .maybeSingle()

    if (!richMenu || !(await isChannelMember(user.id, richMenu.channel_id))) {
        return { error: NextResponse.json({ error: 'リッチメニューが見つかりません' }, { status: 404 }) }
    }

    return { admin, richMenu }
}

/**
 * リッチメニューをLINE APIに登録（登録済みなら今の内容で作り直す）
 * POST /api/rich-menus/register
 *
 * リクエストボディ:
 * - richMenuId: DBのリッチメニューID
 *
 * 使用中のメニューなら、表示中の人へのリンクやデフォルト設定も新しい版に付け替える。
 * 通常は /api/rich-menus/apply（保存時・設定変更時に自動で反映）を使う。
 */
export async function POST(request: NextRequest) {
    const { richMenuId } = await request.json().catch(() => ({}))

    if (!richMenuId) {
        return NextResponse.json({ error: 'richMenuId が必要です' }, { status: 400 })
    }

    const loaded = await loadMenuForMember(richMenuId)
    if ('error' in loaded) return loaded.error

    try {
        const result = await syncChannelRichMenus(loaded.richMenu.channel_id, { publishMenuIds: [richMenuId] })

        const failed = result.failedMenus.find(m => m.id === richMenuId)
        if (failed) {
            return NextResponse.json({ error: failed.message }, { status: 400 })
        }

        const published = result.published.find(m => m.id === richMenuId)
        const { data: latest } = await loaded.admin
            .from('rich_menus')
            .select('rich_menu_id')
            .eq('id', richMenuId)
            .single()

        return NextResponse.json({
            success: true,
            lineRichMenuId: latest?.rich_menu_id ?? null,
            skippedAreaNumbers: published?.skippedAreaNumbers ?? [],
            warnings: result.warnings,
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
 * LINE APIからリッチメニューを取り下げる（DBのメニューは残す）
 * DELETE /api/rich-menus/register?richMenuId=xxx
 *
 * 使用中（全員向け・タグ連動・表示期間あり）のメニューは、取り下げると表示が消えるため断る。
 */
export async function DELETE(request: NextRequest) {
    const richMenuId = request.nextUrl.searchParams.get('richMenuId')

    if (!richMenuId) {
        return NextResponse.json({ error: 'richMenuId が必要です' }, { status: 400 })
    }

    const loaded = await loadMenuForMember(richMenuId)
    if ('error' in loaded) return loaded.error
    const { admin, richMenu } = loaded

    if (!richMenu.rich_menu_id) {
        return NextResponse.json({ error: 'LINE APIに登録されていません' }, { status: 400 })
    }

    const { data: channel } = await admin
        .from('channels')
        .select('channel_access_token, default_rich_menu_id')
        .eq('id', richMenu.channel_id)
        .single()

    const { count: linkedTagCount } = await admin
        .from('tags')
        .select('id', { count: 'exact', head: true })
        .eq('linked_rich_menu_id', richMenuId)

    const inUse =
        richMenu.is_default ||
        channel?.default_rich_menu_id === richMenuId ||
        (linkedTagCount ?? 0) > 0 ||
        hasUpcomingDisplayPeriod(richMenu, new Date())

    if (inUse) {
        return NextResponse.json({
            error: 'このメニューは使用中です（全員向け・タグ・表示期間のいずれかに設定されています）。先に表示設定から外してください。',
        }, { status: 409 })
    }

    try {
        const lineClient = new LineClient(channel!.channel_access_token)
        // LINE から消すと、このメニューを個別に付けていた人のリンクも外れる
        await lineClient.deleteRichMenu(richMenu.rich_menu_id)

        await admin
            .from('rich_menus')
            .update({ rich_menu_id: null })
            .eq('id', richMenuId)

        await admin
            .from('line_users')
            .update({ current_rich_menu_id: null })
            .eq('current_rich_menu_id', richMenuId)

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('LINE API削除エラー:', error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '内部サーバーエラー' },
            { status: 500 }
        )
    }
}
