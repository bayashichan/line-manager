/**
 * API ルートでの「ログインしているか」「そのチャンネルのメンバーか」の確認。
 *
 * middleware は /api を保護しないため、各 API ルートの先頭で必ず確認する。
 * とくにサービスロール（createAdminClient）で DB を触るルートは RLS が効かないので、
 * ここでメンバーであることを確かめてから処理する。
 */

import type { User } from '@supabase/supabase-js'
import { createAdminClient, createClient } from '@/lib/supabase/server'

/** Cookie のセッションからログイン中のユーザーを取得する（未ログインは null） */
export async function getSessionUser(): Promise<User | null> {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    return user
}

/** ユーザーがそのチャンネルのメンバーか */
export async function isChannelMember(userId: string, channelId: string | null | undefined): Promise<boolean> {
    if (!channelId) return false
    const admin = createAdminClient()
    const { data } = await admin
        .from('channel_members')
        .select('id')
        .eq('channel_id', channelId)
        .eq('profile_id', userId)
        .maybeSingle()
    return Boolean(data)
}
