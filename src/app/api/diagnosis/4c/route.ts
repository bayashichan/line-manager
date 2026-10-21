import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyLineAccessToken } from '@/lib/forms/respondent'
import { processRichMenuSwitchOnTagAssign, processRichMenuSwitchOnTagRemove } from '@/lib/rich-menu'
import {
    FOUR_C_MARKER_TAG,
    FOUR_C_RESULT_TAGS,
    fourCTagNames,
    isAllowedFourCOrigin,
    parseFourCResult,
} from '@/lib/diagnosis/four-c'

/**
 * 4C創造性チェックの結果を友だちのタグとして記録する
 * POST /api/diagnosis/4c
 *
 * ヘッダー:
 * - Authorization: Bearer {LIFFのアクセストークン}（本人特定のためサーバー側で検証）
 * ボディ: { stage, goal, brake }
 *
 * 「4C診断済み」タグがあるチャンネルで、本人が友だちなら、段階などのタグを付ける。
 * タグ付与で始まるステップ配信とタグ連動リッチメニューも、通常のタグ付けと同じく動く。
 */
function corsHeaders(origin: string | null): Record<string, string> {
    if (!isAllowedFourCOrigin(origin)) return {}
    return {
        'Access-Control-Allow-Origin': origin!,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        Vary: 'Origin',
    }
}

export async function OPTIONS(request: NextRequest) {
    return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) })
}

export async function POST(request: NextRequest) {
    const headers = corsHeaders(request.headers.get('origin'))
    try {
        const accessToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
        if (!accessToken) {
            return NextResponse.json({ error: 'アクセストークンがありません' }, { status: 401, headers })
        }
        const result = parseFourCResult(await request.json().catch(() => null))
        if (!result) {
            return NextResponse.json({ error: '診断結果の形式が正しくありません' }, { status: 400, headers })
        }
        const verified = await verifyLineAccessToken(accessToken)
        if (!verified) {
            return NextResponse.json({ error: 'ユーザー認証に失敗しました' }, { status: 401, headers })
        }

        const supabase = createAdminClient()

        // 目印のタグがあるチャンネルだけを対象にする
        const { data: markers, error: markerError } = await supabase
            .from('tags')
            .select('channel_id')
            .eq('name', FOUR_C_MARKER_TAG)
        if (markerError) throw new Error(`目印のタグの取得に失敗: ${markerError.message}`)
        const channelIds = (markers ?? []).map((m) => m.channel_id as string)
        if (channelIds.length === 0) {
            return NextResponse.json({ success: true, tagged: 0 }, { headers })
        }

        const { data: friends, error: friendError } = await supabase
            .from('line_users')
            .select('id, channel_id')
            .eq('line_user_id', verified.userId)
            .in('channel_id', channelIds)
        if (friendError) throw new Error(`友だちの取得に失敗: ${friendError.message}`)

        const wanted = fourCTagNames(result)
        for (const friend of friends ?? []) {
            const tagIds = await ensureTags(supabase, friend.channel_id, [...new Set([...wanted, ...FOUR_C_RESULT_TAGS])])

            // 前回の結果のタグを外してから、今回の結果を付ける
            const staleIds = FOUR_C_RESULT_TAGS.filter((n) => !wanted.includes(n)).map((n) => tagIds[n])
            const { data: removed } = await supabase
                .from('line_user_tags')
                .delete()
                .eq('line_user_id', friend.id)
                .in('tag_id', staleIds)
                .select('id')

            const { data: existing } = await supabase
                .from('line_user_tags')
                .select('tag_id')
                .eq('line_user_id', friend.id)
                .in('tag_id', wanted.map((n) => tagIds[n]))
            const already = new Set((existing ?? []).map((r) => r.tag_id as string))
            const added = wanted.map((n) => tagIds[n]).filter((id) => !already.has(id))
            if (added.length > 0) {
                const { error } = await supabase
                    .from('line_user_tags')
                    .upsert(added.map((tag_id) => ({ line_user_id: friend.id, tag_id })), { onConflict: 'line_user_id,tag_id' })
                if (error) throw new Error(`タグ付けに失敗: ${error.message}`)
            }

            try {
                if (removed && removed.length > 0) await processRichMenuSwitchOnTagRemove(friend.id)
                // 新しく付いたタグだけ、タグ付与で始まるステップ配信などを動かす
                for (const tagId of added) await processRichMenuSwitchOnTagAssign(friend.id, tagId)
            } catch (err) {
                console.error(`4C診断のタグ付け後の処理エラー (friend: ${friend.id}):`, err)
            }
        }

        return NextResponse.json({ success: true, tagged: friends?.length ?? 0 }, { headers })
    } catch (error) {
        console.error('4C診断の結果の記録エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500, headers })
    }
}

/** チャンネルに必要なタグがなければ作り、名前から id を引けるようにする */
async function ensureTags(
    supabase: ReturnType<typeof createAdminClient>,
    channelId: string,
    names: string[]
): Promise<Record<string, string>> {
    const { data: found, error } = await supabase
        .from('tags')
        .select('id, name')
        .eq('channel_id', channelId)
        .in('name', names)
    if (error) throw new Error(`タグの取得に失敗: ${error.message}`)
    const ids: Record<string, string> = {}
    for (const t of found ?? []) ids[t.name as string] = t.id as string

    const missing = names.filter((n) => !ids[n])
    if (missing.length > 0) {
        const { data: created, error: createError } = await supabase
            .from('tags')
            .insert(missing.map((name) => ({ channel_id: channelId, name, color: '#387dc9', priority: 0 })))
            .select('id, name')
        if (createError) throw new Error(`タグの作成に失敗: ${createError.message}`)
        for (const t of created ?? []) ids[t.name as string] = t.id as string
    }
    return ids
}
