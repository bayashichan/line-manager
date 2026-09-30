import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import {
    buildRedirectUrl,
    getBaseUrl,
    mcpResourceUrl,
    readAuthorizeParams,
    redirectUriMatches,
    validateAuthorizeParams,
} from '@/lib/mcp/oauth'
import { getClient } from '@/lib/mcp/oauth-store'
import { decideAuthorization } from './actions'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<Record<string, string | string[] | undefined>>

/**
 * AIエージェント連携の同意画面
 * GET /oauth/authorize
 *
 * Claude でコネクタを追加すると、ここが開く。
 * ログインしていなければログイン画面へ送り、ログイン後にここへ戻す。
 */
export default async function AuthorizePage({ searchParams }: { searchParams: SearchParams }) {
    const raw = await searchParams
    const get = (key: string) => {
        const value = raw[key]
        return typeof value === 'string' ? value : undefined
    }
    const params = readAuthorizeParams(get)

    const admin = createAdminClient()
    const client = await getClient(admin, params.clientId)
    if (!client) {
        return <ErrorView message="接続元のアプリが登録されていません。Claude でコネクタを追加し直してください。" />
    }
    if (!params.redirectUri || !redirectUriMatches(client.redirect_uris, params.redirectUri)) {
        return <ErrorView message="戻り先のURLが登録内容と一致しません。Claude でコネクタを追加し直してください。" />
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

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
        const query = new URLSearchParams()
        for (const [key, value] of Object.entries(raw)) {
            if (typeof value === 'string') query.set(key, value)
        }
        redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${query.toString()}`)}`)
    }

    // RLS で自分がメンバーのチャンネルだけが返る
    const { data: channels } = await supabase.from('channels').select('id, name').order('created_at')

    const redirectHost = new URL(params.redirectUri).host
    const hidden: Record<string, string | undefined> = {
        response_type: params.responseType,
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
        state: params.state,
        code_challenge: params.codeChallenge,
        code_challenge_method: params.codeChallengeMethod,
        scope: params.scope,
        resource: params.resource,
    }

    return (
        <Shell>
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle>AIエージェントからの接続を許可しますか？</CardTitle>
                    <CardDescription>
                        <span className="font-medium text-foreground">{client.client_name || '名称未設定のアプリ'}</span>
                        {' '}が LINE Manager への接続を求めています。
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                    <div className="rounded-md border p-3">
                        <p className="text-muted-foreground">許可後の戻り先</p>
                        <p className="font-mono font-medium break-all">{redirectHost}</p>
                        {redirectHost.startsWith('localhost') || redirectHost.startsWith('127.0.0.1') ? (
                            <p className="mt-1 text-amber-600">
                                このパソコン上のアプリ（Claude Code など）に戻ります。自分で接続操作をしていない場合は拒否してください。
                            </p>
                        ) : null}
                    </div>

                    <div>
                        <p className="font-medium">許可すると、AIが次の操作をできるようになります</p>
                        <ul className="mt-1 list-disc pl-5 text-muted-foreground space-y-0.5">
                            <li>ステップ配信の閲覧・作成・編集・オン/オフ・削除</li>
                            <li>タグ一覧と友だちの検索（名前のみ）</li>
                            <li>指定した友だちへのテスト送信</li>
                        </ul>
                        <p className="mt-2 text-muted-foreground">
                            AIが作ったステップ配信はオフの状態で保存されます。配信を始めるには、AIに明示的に指示するか管理画面でオンにしてください。
                        </p>
                    </div>

                    <div>
                        <p className="font-medium">対象のLINE公式アカウント</p>
                        {channels && channels.length > 0 ? (
                            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                                {channels.map(channel => <li key={channel.id}>{channel.name}</li>)}
                            </ul>
                        ) : (
                            <p className="mt-1 text-muted-foreground">まだ参加しているアカウントがありません。</p>
                        )}
                    </div>

                    <p className="text-muted-foreground">ログイン中: {user.email}</p>
                </CardContent>
                <CardFooter>
                    <form action={decideAuthorization} className="flex w-full gap-2">
                        {Object.entries(hidden).map(([name, value]) =>
                            value === undefined ? null : <input key={name} type="hidden" name={name} value={value} />
                        )}
                        <Button type="submit" name="decision" value="deny" variant="outline" className="flex-1">
                            拒否
                        </Button>
                        <Button type="submit" name="decision" value="allow" className="flex-1">
                            許可する
                        </Button>
                    </form>
                </CardFooter>
            </Card>
        </Shell>
    )
}

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-emerald-50 to-green-50 dark:from-slate-950 dark:via-emerald-950 dark:to-green-950 p-4">
            {children}
        </div>
    )
}

function ErrorView({ message }: { message: string }) {
    return (
        <Shell>
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle>接続できませんでした</CardTitle>
                    <CardDescription>{message}</CardDescription>
                </CardHeader>
            </Card>
        </Shell>
    )
}
