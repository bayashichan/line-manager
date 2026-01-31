import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json()
        const { channelId, email, role } = body

        if (!channelId || !email) {
            return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
        }

        // 1. 実行ユーザーの権限チェック（オーナーのみ招待可能）
        const { data: requesterMember } = await supabase
            .from('channel_members')
            .select('role')
            .eq('channel_id', channelId)
            .eq('profile_id', user.id)
            .single()

        if (!requesterMember || requesterMember.role !== 'owner') {
            return NextResponse.json({ error: 'Forbidden: Only owners can invite members' }, { status: 403 })
        }

        // 2. 追加対象のユーザーをメールアドレスで検索
        // RLSを回避するためにAdminクライアントを使用
        const supabaseAdmin = createAdminClient()
        const { data: targetProfile } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('email', email)
            .single()

        if (!targetProfile) {
            return NextResponse.json({ error: 'User not found. The user must sign up first.' }, { status: 404 })
        }

        // 3. 既にメンバーでないかチェック
        const { data: existingMember } = await supabase
            .from('channel_members')
            .select('id')
            .eq('channel_id', channelId)
            .eq('profile_id', targetProfile.id)
            .single()

        if (existingMember) {
            return NextResponse.json({ error: 'User is already a member of this channel' }, { status: 409 })
        }

        // 4. メンバー追加（招待）
        const { error: insertError } = await supabase
            .from('channel_members')
            .insert({
                channel_id: channelId,
                profile_id: targetProfile.id,
                role: role || 'admin',
            })

        if (insertError) throw insertError

        // 5. ログ記録（オプション）
        await supabase.from('activity_logs').insert({
            channel_id: channelId,
            profile_id: user.id,
            action: 'member.invite',
            resource_type: 'member',
            details: { invited_email: email, role: role || 'admin' }
        })

        return NextResponse.json({ success: true })

    } catch (error) {
        console.error('Error inviting member:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
