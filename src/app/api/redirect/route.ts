import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const ch = searchParams.get('ch')
    const oa = searchParams.get('oa')
    const fbclid = searchParams.get('fbclid')
    const fbp = searchParams.get('fbp')
    const tag = searchParams.get('tag')
    const fbc = searchParams.get('fbc') ?? (fbclid ? `fb.1.${Date.now()}.${fbclid}` : null)
    const userAgent = request.headers.get('user-agent')

    if (ch) {
        try {
            const supabase = createAdminClient()
            const { error } = await supabase.from('line_sessions').insert({
                channel_id: ch,
                fbclid: fbclid ?? null,
                fbp: fbp ?? null,
                fbc: fbc ?? null,
                oa: oa ?? null,
                tag: tag ?? null,
                user_agent: userAgent ?? null,
            })
            if (error) console.error('line_sessions INSERT error:', error)
        } catch (err) {
            console.error('redirect: DB error:', err)
        }
    }

    const bridgeUrl = new URL('/bridge', request.url)
    if (ch) bridgeUrl.searchParams.set('ch', ch)
    if (oa) bridgeUrl.searchParams.set('oa', oa)

    return NextResponse.redirect(bridgeUrl, { status: 302 })
}
