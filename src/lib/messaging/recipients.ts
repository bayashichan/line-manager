import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

export type Recipient = {
    id: string
    line_user_id: string
    display_name: string | null
}

export type ResolveRecipientsParams = {
    channelId: string
    filterTags?: string[] | null
    excludeTags?: string[] | null
}

/**
 * 配信対象の友だちを解決する（一斉配信・予約配信で共通利用）。
 *
 * 実装上の注意:
 * - PostgREST は1リクエスト既定1000行までしか返さないため、必ずページングして全件取得する。
 *   ここを取りこぼすと「1000人にしか配信されない」「除外タグが効かない」といった事故になる。
 * - タグの絞り込み・除外は `.in()` / `.not(...in...)` をURLに載せると友だち数に比例して
 *   クエリ文字列が肥大化し、件数が増えたときにリクエストが壊れる。そのためタグの所属集合を
 *   取得したうえで JS 側で突き合わせる。
 * - タグ集合の取得に失敗した場合はエラーを返す。除外タグの取得に失敗したまま送ると、
 *   本来除外すべき相手に配信してしまうため、呼び出し元は必ず中断すること。
 */
export async function resolveRecipients(
    client: SupabaseClient,
    { channelId, filterTags, excludeTags }: ResolveRecipientsParams
): Promise<{ recipients: Recipient[]; error: unknown }> {
    const { data: users, error: usersError } = await fetchAllRows<Recipient>((from, to) =>
        client
            .from('line_users')
            .select('id, line_user_id, display_name')
            .eq('channel_id', channelId)
            .eq('is_blocked', false)
            .order('id', { ascending: true })
            .range(from, to)
    )

    if (usersError) {
        return { recipients: [], error: usersError }
    }

    let includeIds: Set<string> | null = null
    if (filterTags && filterTags.length > 0) {
        const { ids, error } = await fetchTaggedUserIds(client, filterTags)
        if (error) return { recipients: [], error }
        includeIds = ids
    }

    let excludeIds: Set<string> = new Set()
    if (excludeTags && excludeTags.length > 0) {
        const { ids, error } = await fetchTaggedUserIds(client, excludeTags)
        if (error) return { recipients: [], error }
        excludeIds = ids
    }

    const recipients = users.filter(
        user => (!includeIds || includeIds.has(user.id)) && !excludeIds.has(user.id)
    )

    return { recipients, error: null }
}

/**
 * 指定タグのいずれかが付いている友だちの内部ID集合を取得する。
 * line_user_tags.line_user_id は line_users.id（内部UUID）を指す。
 */
async function fetchTaggedUserIds(
    client: SupabaseClient,
    tagIds: string[]
): Promise<{ ids: Set<string>; error: unknown }> {
    const { data, error } = await fetchAllRows<{ id: string; line_user_id: string }>((from, to) =>
        client
            .from('line_user_tags')
            .select('id, line_user_id')
            .in('tag_id', tagIds)
            .order('id', { ascending: true })
            .range(from, to)
    )

    if (error) {
        return { ids: new Set(), error }
    }

    return { ids: new Set(data.map(row => row.line_user_id)), error: null }
}
