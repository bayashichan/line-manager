import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'
import { normalizeApplicantProfile, applyPendingApplicantProfiles } from '@/lib/applicants'

/**
 * 外部の申込フォームから申込者を連携する
 * POST /api/applicants/register
 *
 * 認証: Authorization: Bearer ${APPLICANT_INGEST_SECRET}
 *
 * リクエストボディ:
 * - channelId:   連携先チャネルのUUID
 * - lineUserId:  LINEのuserId
 * - displayName: LINE表示名（任意）
 * - source:      申込元の識別子（例: buchiiyashi-apply）
 * - appliedAt:   申込日時（ISO文字列、任意）
 * - internalName: 友だちの管理用ネームに登録する名前（任意。例: 出展名）
 * - tagNames:    友だちに付与するタグ名の配列（任意。例: ["第7回出展者"]）。無いタグは作成する
 *
 * 処理:
 *  1. Messaging API で「本当に友だちか」を判定する
 *     （LIFFのログインは認証であって友だち追加ではないため、userIdが取れても友だちとは限らない）
 *  2. 友だちなら line_users に upsert（Webhook取りこぼしの救済にもなる）
 *  3. 友だち・非友だちを問わず applicants に記録する
 *  4. 友だちなら管理用ネーム・タグをその場で反映する。
 *     未友だちなら applicants に控えておき、友だち追加（Webhook）のときに反映する
 *
 * 呼び出しは必ずサーバー間で行うこと。シークレットをブラウザに渡してはいけない。
 */
export async function POST(request: NextRequest) {
    const secret = process.env.APPLICANT_INGEST_SECRET
    if (!secret) {
        console.error('APPLICANT_INGEST_SECRET が未設定のため申込者連携を受け付けられません')
        return NextResponse.json({ error: 'サーバー設定エラー' }, { status: 500 })
    }

    if (request.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: '認証エラー' }, { status: 401 })
    }

    try {
        const body = await request.json()
        const channelId: string | undefined = body.channelId
        const lineUserId: string | undefined = body.lineUserId
        const displayName: string | null = body.displayName ?? null
        const source: string | undefined = body.source
        const appliedAt: string | null = body.appliedAt ?? null
        const profile = normalizeApplicantProfile(body)

        if (!channelId || !lineUserId || !source) {
            return NextResponse.json(
                { error: 'channelId, lineUserId, source は必須です' },
                { status: 400 }
            )
        }

        const supabase = createAdminClient()

        const { data: channel, error: channelError } = await supabase
            .from('channels')
            .select('id, channel_access_token')
            .eq('id', channelId)
            .single()

        if (channelError || !channel) {
            return NextResponse.json({ error: 'チャネルが見つかりません' }, { status: 404 })
        }

        // --------------------------------------------------------------------
        // STEP 1: 友だち判定
        // --------------------------------------------------------------------
        const lineClient = new LineClient(channel.channel_access_token)
        const check = await lineClient.getProfileForFriendCheck(lineUserId)

        // 判定できなかった場合は「非友だち」と断定せず、記録もせずにエラーを返す。
        // 誤って未友だち扱いで保存すると、実際は友だちの人に追加案内を送ってしまう。
        if (check.status === 'error') {
            console.error(
                `友だち判定に失敗 (userId: ${lineUserId}, channel: ${channelId}): ` +
                `HTTP ${check.httpStatus} ${check.detail}`
            )
            return NextResponse.json(
                { error: '友だち判定に失敗しました' },
                { status: 502 }
            )
        }

        const isFriend = check.status === 'friend'

        // --------------------------------------------------------------------
        // STEP 2: 友だちなら line_users に反映する
        // Webhook を取りこぼしていた友だちを、ここで救済して一覧に載せる。
        // followed_at は指定しない（新規行はDBのDEFAULT NOW()、既存行は元の値を維持）。
        // --------------------------------------------------------------------
        let linkedLineUserId: string | null = null

        if (check.status === 'friend') {
            const { data: upserted, error: upsertError } = await supabase
                .from('line_users')
                .upsert(
                    {
                        channel_id: channelId,
                        line_user_id: lineUserId,
                        display_name: check.profile.displayName,
                        picture_url: check.profile.pictureUrl,
                        status_message: check.profile.statusMessage,
                        is_blocked: false,
                    },
                    { onConflict: 'channel_id,line_user_id' }
                )
                .select('id')
                .single()

            if (upsertError || !upserted) {
                console.error(`申込者のline_users保存に失敗 (userId: ${lineUserId}):`, upsertError)
                return NextResponse.json({ error: '友だち情報の保存に失敗しました' }, { status: 500 })
            }

            linkedLineUserId = upserted.id
        }

        // --------------------------------------------------------------------
        // STEP 3: applicants に記録
        // 管理用ネーム・タグは「未反映」として控える（反映は STEP 4 か友だち追加時）。
        // 未友だちのまま再申込した場合は、前回の未反映タグを捨てずに引き継ぐ。
        // --------------------------------------------------------------------
        const { data: previous, error: previousError } = await supabase
            .from('applicants')
            .select('internal_name, tag_names, profile_applied_at')
            .eq('channel_id', channelId)
            .eq('line_user_id', lineUserId)
            .eq('source', source)
            .maybeSingle()

        if (previousError) {
            console.error(`申込者の取得に失敗 (userId: ${lineUserId}):`, previousError)
            return NextResponse.json({ error: '申込者の保存に失敗しました' }, { status: 500 })
        }

        const carryOver = previous && !previous.profile_applied_at ? previous : null
        const tagNames = [...new Set([...((carryOver?.tag_names as string[] | null) || []), ...profile.tagNames])]

        const { error: applicantError } = await supabase.from('applicants').upsert(
            {
                channel_id: channelId,
                line_user_id: lineUserId,
                display_name: isFriend ? check.profile.displayName : displayName,
                source,
                is_friend: isFriend,
                linked_line_user_id: linkedLineUserId,
                applied_at: appliedAt,
                internal_name: profile.internalName ?? carryOver?.internal_name ?? null,
                tag_names: tagNames,
                profile_applied_at: null,
            },
            { onConflict: 'channel_id,line_user_id,source' }
        )

        if (applicantError) {
            console.error(`申込者の保存に失敗 (userId: ${lineUserId}):`, applicantError)
            return NextResponse.json({ error: '申込者の保存に失敗しました' }, { status: 500 })
        }

        // --------------------------------------------------------------------
        // STEP 4: 友だちなら管理用ネーム・タグを反映する
        // 申込の記録は済んでいるので、ここで失敗しても未反映として残り、
        // 次にWebhook（メッセージ受信など）が届いたときに再試行される。
        // --------------------------------------------------------------------
        let profileApplied = false

        if (linkedLineUserId) {
            try {
                await applyPendingApplicantProfiles(supabase, channelId, lineUserId, linkedLineUserId)
                profileApplied = true
            } catch (err) {
                console.error(`申込者の管理用ネーム・タグの反映に失敗 (userId: ${lineUserId}):`, err)
            }
        }

        console.log(
            `申込者連携: ${lineUserId} (source: ${source}) → ${isFriend ? '友だち' : '未友だち'}` +
            (profileApplied ? '（管理用ネーム・タグ反映済み）' : '')
        )

        return NextResponse.json({ success: true, isFriend, profileApplied })
    } catch (error) {
        console.error('申込者連携エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
