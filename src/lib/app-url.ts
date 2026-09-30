/**
 * QStash など外部のサービスから、このアプリを呼び戻してもらうときの URL を決める。
 *
 * VERCEL_URL / NEXT_PUBLIC_VERCEL_URL（デプロイごとに発行される URL）は使わないこと。
 * Vercel の Deployment Protection（標準で有効）により、この URL は外部から呼ぶと
 * 認証画面（401）で弾かれる。公開されているのは本番ドメインだけ。
 * 参考: https://vercel.com/docs/deployment-protection
 *
 * 優先順位:
 * 1. APP_BASE_URL（独自ドメインなどで固定したい場合）
 * 2. いま届いたリクエストのホスト（LINE や管理画面が実際にアクセスできた公開ドメイン）
 * 3. VERCEL_PROJECT_PRODUCTION_URL（Vercel が用意する本番ドメイン）
 */
export function getAppBaseUrl(
    headers: Pick<Headers, 'get'> | null,
    env: Record<string, string | undefined> = process.env
): string {
    if (env.APP_BASE_URL) return env.APP_BASE_URL.replace(/\/+$/, '')

    const host = headers?.get('x-forwarded-host')?.split(',')[0]?.trim() || headers?.get('host')?.trim()
    if (host) {
        const forwardedProto = headers?.get('x-forwarded-proto')?.split(',')[0]?.trim()
        const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1')
        return `${forwardedProto || (isLocal ? 'http' : 'https')}://${host}`
    }

    if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`

    return 'https://line-manager-omega.vercel.app'
}
