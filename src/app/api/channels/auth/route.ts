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

        if (!channelId || !password) {
            return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
        }

        // チャンネル情報を取得（パスワードハッシュを含む）
        const { data: channel } = await supabase
            .from('channels')
            .select('access_password')
            .eq('id', channelId)
            .single()

        if (!channel) {
            return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
        }

        // パスワードが設定されていない場合は認証不要（OKを返す）
        if (!channel.access_password) {
            return NextResponse.json({ success: true })
        }

        // パスワード検証
        const inputHash = createHash('sha256').update(password).digest('hex')

        if (inputHash === channel.access_password) {
            return NextResponse.json({ success: true })
        } else {
            return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
        }

    } catch (error) {
        console.error('Error verifying password:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
