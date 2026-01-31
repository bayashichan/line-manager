import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
    let supabaseResponse = NextResponse.next({
        request,
    })

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll()
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value }) =>
                        request.cookies.set(name, value)
                    )
                    supabaseResponse = NextResponse.next({
                        request,
                    })
                    cookiesToSet.forEach(({ name, value, options }) =>
                        supabaseResponse.cookies.set(name, value, options as CookieOptions)
                    )
                },
            },
        }
    )

    // セッションのリフレッシュ
    const {
        data: { user },
    } = await supabase.auth.getUser()

    // 認証が必要なページへのアクセス制御
    const isAuthPage = request.nextUrl.pathname.startsWith('/login') ||
        request.nextUrl.pathname.startsWith('/signup')
    const isProtectedPage = request.nextUrl.pathname.startsWith('/dashboard')
    const isApiRoute = request.nextUrl.pathname.startsWith('/api')
    const isWebhook = request.nextUrl.pathname.startsWith('/api/webhook')

    // Webhookは認証不要
    if (isWebhook) {
        return supabaseResponse
    }

    // 未認証ユーザーが保護ページにアクセス
    if (!user && isProtectedPage) {
        const url = request.nextUrl.clone()
        url.pathname = '/login'
        return NextResponse.redirect(url)
    }

    // 認証済みユーザーが認証ページにアクセス
    if (user && isAuthPage) {
        const url = request.nextUrl.clone()
        url.pathname = '/dashboard'
        return NextResponse.redirect(url)
    }

    return supabaseResponse
}
