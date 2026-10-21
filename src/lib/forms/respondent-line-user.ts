import type { SupabaseClient } from '@supabase/supabase-js'
import { isKnownDisplayName } from '@/lib/line/display-name'
import type { FormResponse, LineUser } from '@/types'

/**
 * 申込フォームの申込者と友だち情報（line_users）の突き合わせ（申込者一覧・回答一覧で共通）。
 */

export type RespondentLineUser = Pick<
    LineUser,
    'id' | 'line_user_id' | 'display_name' | 'internal_name' | 'picture_url' | 'is_blocked'
>

// line_users を userId の IN 句で引くときの分割数（URL長の上限に当てないため）
const USER_LOOKUP_CHUNK = 100

/**
 * 申込者の友だち情報を LINE の userId（form_responses.line_user_id_raw）で引く。
 * 申込の後に友だち追加した人も友だちとして扱えるよう、保存時の内部IDではなく userId で引き直す。
 * 戻り値は userId → 友だち情報。途中で失敗したときは、取れた分とエラーを返す。
 */
export async function fetchRespondentLineUsers(
    client: SupabaseClient,
    channelId: string,
    responses: Pick<FormResponse, 'line_user_id_raw'>[]
): Promise<{ data: Record<string, RespondentLineUser>; error: unknown }> {
    const rawIds = [...new Set(responses.map(r => r.line_user_id_raw).filter((id): id is string => !!id))]
    const userMap: Record<string, RespondentLineUser> = {}

    for (let i = 0; i < rawIds.length; i += USER_LOOKUP_CHUNK) {
        const { data, error } = await client
            .from('line_users')
            .select('id, line_user_id, display_name, internal_name, picture_url, is_blocked')
            .eq('channel_id', channelId)
            .in('line_user_id', rawIds.slice(i, i + USER_LOOKUP_CHUNK))
        if (error) return { data: userMap, error }
        for (const u of (data ?? []) as RespondentLineUser[]) {
            userMap[u.line_user_id] = u
        }
    }

    return { data: userMap, error: null }
}

/**
 * 申込者のLINE登録名（表示名）。管理用ネームは含めない。
 * 友だち情報の名前（最新）を優先し、無ければ申込時に控えた名前を使う。どちらも無ければ空文字。
 */
export function respondentLineName(
    response: Pick<FormResponse, 'line_display_name'>,
    user: Pick<LineUser, 'display_name'> | undefined
): string {
    const current = user?.display_name
    if (isKnownDisplayName(current)) return current
    // マイグレーション適用前は列が無い（undefined）
    const saved = response.line_display_name
    return isKnownDisplayName(saved) ? saved : ''
}
