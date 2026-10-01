import { createAdminClient } from '@/lib/supabase/server'
import { processRichMenuSwitchOnTagAssign, processRichMenuSwitchOnTagRemove } from '@/lib/rich-menu'

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * 申込者の友だち情報へ反映する内容
 */
export interface ApplicantProfile {
    /** 管理用ネームに登録する名前（出展名など）。null なら変更しない */
    internalName: string | null
    /** 付与するタグ名。無いタグは作成する */
    tagNames: string[]
    /**
     * 外すタグ名（例: キャンセル待ちから繰り上げた人の「第7回キャンセル待ち」）。
     * 付与するタグと同じ名前は外さない
     */
    removeTagNames: string[]
}

const MAX_INTERNAL_NAME_LENGTH = 100
const MAX_TAG_NAME_LENGTH = 50
const MAX_TAGS = 10

/**
 * 申込フォームから届いた値を整える。
 * 出展名は改行入りで届くことがある（スライド用の改行）ため、1行にまとめる。
 */
export function normalizeApplicantProfile(input: {
    internalName?: unknown
    tagNames?: unknown
    removeTagNames?: unknown
}): ApplicantProfile {
    const internalName =
        typeof input.internalName === 'string'
            ? input.internalName.replace(/\s+/g, ' ').trim().slice(0, MAX_INTERNAL_NAME_LENGTH)
            : ''

    const tagNames = normalizeTagNames(input.tagNames)
    const removeTagNames = normalizeTagNames(input.removeTagNames).filter(name => !tagNames.includes(name))

    return {
        internalName: internalName || null,
        tagNames,
        removeTagNames,
    }
}

function normalizeTagNames(input: unknown): string[] {
    const names = Array.isArray(input)
        ? input
            .filter((name): name is string => typeof name === 'string')
            .map(name => name.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_NAME_LENGTH))
            .filter(name => name.length > 0)
        : []
    return [...new Set(names)].slice(0, MAX_TAGS)
}

/**
 * 友だちからタグを外す（名前で指定。無いタグ・付いていないタグは何もしない）。
 * 外したときは、タグ連動のリッチメニューも付け直す（管理画面でタグを外したときと同じ）。
 * 友だち追加の有無にかかわらず、友だち一覧に載っている人なら外せる（ブロック中の人も含む）。
 */
export async function removeApplicantTags(
    supabase: AdminClient,
    channelId: string,
    internalUserId: string,
    tagNames: string[]
): Promise<void> {
    if (tagNames.length === 0) return

    const { data: tags, error: tagsError } = await supabase
        .from('tags')
        .select('id')
        .eq('channel_id', channelId)
        .in('name', tagNames)

    if (tagsError) {
        throw new Error(`外すタグの取得に失敗: ${tagsError.message}`)
    }
    const tagIds = (tags || []).map(t => t.id as string)
    if (tagIds.length === 0) return

    const { data: removed, error: deleteError } = await supabase
        .from('line_user_tags')
        .delete()
        .eq('line_user_id', internalUserId)
        .in('tag_id', tagIds)
        .select('tag_id')

    if (deleteError) {
        throw new Error(`タグを外すのに失敗: ${deleteError.message}`)
    }
    if (!removed || removed.length === 0) return

    // タグ外し自体は完了している。リッチメニュー切替の失敗はログのみ
    try {
        await processRichMenuSwitchOnTagRemove(internalUserId)
    } catch (err) {
        console.error(`申込者タグ解除のリッチメニュー切替エラー (user: ${internalUserId}):`, err)
    }
}

/**
 * 友だちに管理用ネームとタグを反映する。
 * タグは名前で探し、無ければ作る（既存タグの色やリッチメニュー連動は触らない）。
 * 新しく付いたタグについては、タグ連動のリッチメニュー切替とステップ配信も動かす。
 */
export async function applyApplicantProfile(
    supabase: AdminClient,
    channelId: string,
    internalUserId: string,
    profile: ApplicantProfile
): Promise<void> {
    if (profile.internalName) {
        const { error } = await supabase
            .from('line_users')
            .update({ internal_name: profile.internalName })
            .eq('id', internalUserId)

        if (error) {
            throw new Error(`管理用ネームの更新に失敗: ${error.message}`)
        }
    }

    if (profile.tagNames.length === 0) return

    const { error: createError } = await supabase
        .from('tags')
        .upsert(
            profile.tagNames.map(name => ({ channel_id: channelId, name })),
            { onConflict: 'channel_id,name', ignoreDuplicates: true }
        )

    if (createError) {
        throw new Error(`タグの作成に失敗: ${createError.message}`)
    }

    const { data: tags, error: tagsError } = await supabase
        .from('tags')
        .select('id')
        .eq('channel_id', channelId)
        .in('name', profile.tagNames)

    if (tagsError || !tags) {
        throw new Error(`タグの取得に失敗: ${tagsError?.message}`)
    }

    const tagIds = tags.map(t => t.id as string)

    // 付いていなかったタグだけを付ける。既に付いているタグでステップ配信を再開させないため
    const { data: assigned, error: assignedError } = await supabase
        .from('line_user_tags')
        .select('tag_id')
        .eq('line_user_id', internalUserId)
        .in('tag_id', tagIds)

    if (assignedError) {
        throw new Error(`タグ付けの確認に失敗: ${assignedError.message}`)
    }

    const assignedIds = new Set((assigned || []).map(a => a.tag_id as string))
    const newTagIds = tagIds.filter(id => !assignedIds.has(id))
    if (newTagIds.length === 0) return

    const { error: assignError } = await supabase
        .from('line_user_tags')
        .upsert(
            newTagIds.map(tagId => ({ line_user_id: internalUserId, tag_id: tagId })),
            { onConflict: 'line_user_id,tag_id', ignoreDuplicates: true }
        )

    if (assignError) {
        throw new Error(`タグ付けに失敗: ${assignError.message}`)
    }

    // タグ付け自体は完了している。リッチメニュー切替・ステップ配信の失敗はログのみ
    for (const tagId of newTagIds) {
        try {
            await processRichMenuSwitchOnTagAssign(internalUserId, tagId)
        } catch (err) {
            console.error(`申込者タグのリッチメニュー切替エラー (user: ${internalUserId}, tag: ${tagId}):`, err)
        }
    }
}

/**
 * 未反映の申込（申込時点で未友だちだった人など）を、友だち情報へ反映する。
 *
 * 申込の連携時と、Webhook（友だち追加・メッセージ受信）のときに呼ぶ。
 * 複数の申込がある場合、管理用ネームは最新の申込のものを、タグはすべてを反映する。
 * 反映に失敗した申込は未反映のまま残し、次の呼び出しで再試行する。
 */
export async function applyPendingApplicantProfiles(
    supabase: AdminClient,
    channelId: string,
    lineUserId: string,
    internalUserId: string
): Promise<void> {
    const { data: pending, error } = await supabase
        .from('applicants')
        .select('id, internal_name, tag_names, applied_at, created_at')
        .eq('channel_id', channelId)
        .eq('line_user_id', lineUserId)
        .is('profile_applied_at', null)

    if (error) {
        throw new Error(`未反映の申込の取得に失敗: ${error.message}`)
    }
    if (!pending || pending.length === 0) return

    const latestFirst = [...pending].sort((a, b) => {
        const timeA = new Date(a.applied_at || a.created_at).getTime()
        const timeB = new Date(b.applied_at || b.created_at).getTime()
        return timeB - timeA
    })

    await applyApplicantProfile(supabase, channelId, internalUserId, {
        internalName: latestFirst.find(a => a.internal_name)?.internal_name ?? null,
        tagNames: [...new Set(latestFirst.flatMap(a => (a.tag_names as string[] | null) || []))],
        removeTagNames: [],
    })

    const { error: markError } = await supabase
        .from('applicants')
        .update({ profile_applied_at: new Date().toISOString() })
        .in('id', pending.map(a => a.id))

    if (markError) {
        throw new Error(`反映済みの記録に失敗: ${markError.message}`)
    }

    console.log(
        `申込者の情報を友だちへ反映 (userId: ${lineUserId}): ` +
        `申込 ${pending.length} 件`
    )
}
