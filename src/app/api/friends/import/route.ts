import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { v4 as uuidv4 } from 'uuid'

export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { channelId, data } = await request.json()

        if (!channelId || !data || !Array.isArray(data)) {
            return NextResponse.json({ error: '無効なリクエストデータです' }, { status: 400 })
        }

        // 権限チェック
        const { data: membership } = await supabase
            .from('channel_members')
            .select('role')
            .eq('channel_id', channelId)
            .eq('profile_id', user.id)
            .single()

        if (!membership) {
            return NextResponse.json({ error: '権限がありません' }, { status: 403 })
        }

        // 重複を避けるためにタグを事前に取得または作成
        // データから全タグ名を抽出
        const allTagNames = new Set<string>()
        data.forEach((row: any) => {
            if (row.tags && typeof row.tags === 'string') {
                row.tags.split(',').map((t: string) => t.trim()).filter(Boolean).forEach((t: string) => allTagNames.add(t))
            }
        })

        const uniqueTagNames = Array.from(allTagNames)
        const tagMap = new Map<string, string>() // Name -> ID

        if (uniqueTagNames.length > 0) {
            // 既存タグ取得
            const { data: existingTags } = await supabase
                .from('tags')
                .select('id, name')
                .eq('channel_id', channelId)
                .in('name', uniqueTagNames)

            if (existingTags) {
                existingTags.forEach(tag => tagMap.set(tag.name, tag.id))
            }

            // 新規タグ作成
            const newTags = uniqueTagNames.filter(name => !tagMap.has(name))
            if (newTags.length > 0) {
                const { data: createdTags, error: tagError } = await supabase
                    .from('tags')
                    .insert(newTags.map(name => ({
                        channel_id: channelId,
                        name: name,
                        priority: 0
                    })))
                    .select('id, name')

                if (tagError) {
                    console.error('タグ作成エラー:', tagError)
                    return NextResponse.json({ error: 'タグの作成に失敗しました' }, { status: 500 })
                }

                if (createdTags) {
                    createdTags.forEach(tag => tagMap.set(tag.name, tag.id))
                }
            }
        }

        // ユーザーとタグ紐付けの処理
        let successCount = 0
        let failureCount = 0
        const errors: string[] = []

        // バッチ処理推奨だが、簡単のためループで処理（件数が多すぎるとタイムアウトする可能性あり）
        // TODO: 大量データの場合はキューイングなどを検討

        // ユーザー情報のUpsert
        // Supabaseのupsertは一括実行可能
        const usersToUpsert = data.map((row: any) => ({
            channel_id: channelId,
            line_user_id: row.lineUserId,
            display_name: row.displayName,
            // 既存のデータがあればそれを保持したい場合は注意が必要だが、
            // ここではCSVの情報を正として更新する
            followed_at: row.followedAt ? new Date(row.followedAt).toISOString() : new Date().toISOString(),
        })).filter((u: any) => u.line_user_id) // IDがないものは除外

        if (usersToUpsert.length === 0) {
            return NextResponse.json({ processed: 0, success: 0, failure: data.length, errors: ['有効なLINE User IDが見つかりません'] })
        }

        const { data: upsertedUsers, error: upsertError } = await supabase
            .from('line_users')
            .upsert(usersToUpsert, { onConflict: 'channel_id, line_user_id' })
            .select('id, line_user_id')

        if (upsertError) {
            console.error('ユーザー一括登録エラー:', upsertError)
            return NextResponse.json({ error: 'ユーザーの登録に失敗しました' }, { status: 500 })
        }

        // ユーザーIDのマップを作成 (LineUserID -> UUID)
        const userIdMap = new Map<string, string>()
        if (upsertedUsers) {
            upsertedUsers.forEach(u => userIdMap.set(u.line_user_id, u.id))
        }

        // タグ紐付け用データ作成
        const tagLinksToInsert: { line_user_id: string, tag_id: string }[] = []

        data.forEach((row: any) => {
            const uuid = userIdMap.get(row.lineUserId)
            if (uuid && row.tags) {
                const tagNames = row.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
                tagNames.forEach((tagName: string) => {
                    const tagId = tagMap.get(tagName)
                    if (tagId) {
                        tagLinksToInsert.push({
                            line_user_id: uuid,
                            tag_id: tagId
                        })
                    }
                })
            }
        })

        if (tagLinksToInsert.length > 0) {
            // タグ紐付けの一括登録 (重複無視)
            const { error: linkError } = await supabase
                .from('line_user_tags')
                .upsert(tagLinksToInsert, { onConflict: 'line_user_id, tag_id', ignoreDuplicates: true })

            if (linkError) {
                console.error('タグ紐付けエラー:', linkError)
                // 致命的ではないとして続行、またはエラーリストに追加
            }
        }

        return NextResponse.json({
            success: true,
            processed: usersToUpsert.length,
            tagCount: tagLinksToInsert.length
        })

    } catch (error) {
        console.error('詳細エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
