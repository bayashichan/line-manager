'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import {
    buildRedirectUrl,
    getBaseUrl,
    mcpResourceUrl,
    readAuthorizeParams,
    redirectUriMatches,
    validateAuthorizeParams,
} from '@/lib/mcp/oauth'
import { createAuthorizationCode, getClient } from '@/lib/mcp/oauth-store'

/**
 * 同意画面で「許可」「拒否」を押したときの処理。
 *
 * フォームの hidden 値は改ざんできるため、ページ表示時と同じ検証をここでもやり直す。
 * Server Action は Next.js が Origin を検証するので、他サイトからの自動送信（CSRF）は通らない。
 */
export async function decideAuthorization(formData: FormData) {
    const get = (key: string) => {
        const value = formData.get(key)
        return typeof value === 'string' ? value : undefined
    }
    const params = readAuthorizeParams(get)
    const decision = get('decision')

    const admin = createAdminClient()
    const client = await getClient(admin, params.clientId)
    if (!client || !redirectUriMatches(client.redirect_uris, params.redirectUri)) {
        // 戻り先が信用できないときはリダイレクトしない
        throw new Error('不正な認可リクエストです')
    }

    const baseUrl = getBaseUrl(await headers())
    const invalid = validateAuthorizeParams(params, mcpResourceUrl(baseUrl))
    if (invalid) {
        redirect(buildRedirectUrl(params.redirectUri, {
            error: invalid.error,
            error_description: invalid.description,
            state: params.state,
        }))
    }

    if (decision !== 'allow') {
        redirect(buildRedirectUrl(params.redirectUri, { error: 'access_denied', state: params.state }))
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
        redirect(buildRedirectUrl(params.redirectUri, {
            error: 'access_denied',
            error_description: 'ログインが切れています。もう一度接続してください',
            state: params.state,
        }))
    }

    const code = await createAuthorizationCode(admin, {
        clientId: client.client_id,
        userId: user.id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scope: params.scope,
        resource: params.resource,
    })

    redirect(buildRedirectUrl(params.redirectUri, { code, state: params.state }))
}
