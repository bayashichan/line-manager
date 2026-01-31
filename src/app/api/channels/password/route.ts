import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { createHash } from 'crypto'

export async function POST(request: Request) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json()
        const { channelId, password } = body

        if (!channelId) {
            return NextResponse.json({ error: 'Channel ID is required' }, { status: 400 })
        }

        // 権限チェック
        const { data: member } = await supabase
            .from('channel_members')
            .select('role')
            .eq('channel_id', channelId)
            .eq('profile_id', user.id)
            .single()

        if (!member) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        let hashedPassword = null
        if (password) {
            // パスワードをハッシュ化
            hashedPassword = createHash('sha256').update(password).digest('hex')
        }

        // 更新
        const { error } = await supabase
            .from('channels')
            .update({ access_password: hashedPassword })
            .eq('id', channelId)

        if (error) throw error

        return NextResponse.json({ success: true })

    } catch (error) {
        console.error('Error updating password:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
