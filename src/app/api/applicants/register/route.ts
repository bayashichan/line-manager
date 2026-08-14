import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient } from '@/lib/line'

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
 *
 * 処理:
 *  1. Messaging API で「本当に友だちか」を判定する
 *     （LIFFのログインは認証であって友だち追加ではないため、userIdが取れても友だちとは限らない）
 *  2. 友だちなら line_users に upsert（Webhook取りこぼしの救済にもなる）
 *  3. 友だち・非友だちを問わず applicants に記録する
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
        // --------------------------------------------------------------------
        const { error: applicantError } = await supabase.from('applicants').upsert(
            {
                channel_id: channelId,
                line_user_id: lineUserId,
                display_name: isFriend ? check.profile.displayName : displayName,
                source,
                is_friend: isFriend,
                linked_line_user_id: linkedLineUserId,
                applied_at: appliedAt,
            },
            { onConflict: 'channel_id,line_user_id,source' }
        )

        if (applicantError) {
            console.error(`申込者の保存に失敗 (userId: ${lineUserId}):`, applicantError)
            return NextResponse.json({ error: '申込者の保存に失敗しました' }, { status: 500 })
        }

        console.log(
            `申込者連携: ${lineUserId} (source: ${source}) → ${isFriend ? '友だち' : '未友だち'}`
        )

        return NextResponse.json({ success: true, isFriend })
    } catch (error) {
        console.error('申込者連携エラー:', error)
        return NextResponse.json({ error: '内部サーバーエラー' }, { status: 500 })
    }
}
