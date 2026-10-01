import type { Metadata } from 'next'

export const metadata: Metadata = {
    title: 'プライバシーポリシー | LINE Manager',
}

/**
 * プライバシーポリシー（ログインなしで見られる公開ページ）。
 * Google Cloud の OAuth 同意画面（ブランディング）に登録する URL として使う。
 * Google のユーザーデータの扱いは「Google API サービスのユーザーデータに関するポリシー」に合わせて書いている。
 */
export default function PrivacyPage() {
    return (
        <main className="min-h-screen bg-gray-50 px-4 py-10">
            <article className="mx-auto max-w-3xl space-y-8 rounded-xl bg-white p-6 text-sm leading-7 text-gray-700 shadow-sm sm:p-10">
                <header className="space-y-2">
                    <h1 className="text-2xl font-bold text-gray-900">プライバシーポリシー</h1>
                    <p>
                        LINE Manager（以下「本ツール」）は、LINE 公式アカウントの運営者が、友だちとのやりとり・配信・面談の日程調整を行うための管理ツールです。
                        本ツールで扱う情報と、その使い方を次のとおり定めます。
                    </p>
                </header>

                <section className="space-y-2">
                    <h2 className="text-lg font-semibold text-gray-900">1. LINE の友だちに関する情報</h2>
                    <ul className="list-disc space-y-1 pl-5">
                        <li>LINE のユーザー ID・表示名・プロフィール画像、本ツールとのメッセージのやりとり、面談の予約日時、フォームへの回答</li>
                        <li>使い道: メッセージの送受信、自動応答、配信、面談の日程調整とリマインダーの送信</li>
                        <li>LINE 公式アカウントの運営者以外に提供することはありません（法令に基づく場合を除く）</li>
                    </ul>
                </section>

                <section className="space-y-2">
                    <h2 className="text-lg font-semibold text-gray-900">2. Google のアカウントに関する情報（Googleカレンダー連携）</h2>
                    <p>運営者が Googleカレンダーとの連携を許可した場合に限り、次の情報を扱います。</p>
                    <ul className="list-disc space-y-1 pl-5">
                        <li>連携した Google アカウントのメールアドレス（連携先の表示のため）</li>
                        <li>カレンダーの予定がある時間帯（面談の空き枠を作るため）</li>
                        <li>面談の予約が確定したときに作成する予定と Google Meet の URL（予約を取り消したときは予定を削除します）</li>
                    </ul>
                    <p>
                        本ツールが作成したもの以外の予定の内容（件名・参加者など）を読み取ったり保存したりすることはありません。
                        Google への接続に必要な情報はサーバーのデータベースに保存し、本ツールのサーバー以外からは読み取れないよう制限しています。
                    </p>
                    <p>
                        Google から受け取った情報は上記の目的にだけ使い、第三者への提供・販売、広告への利用、AI の学習への利用は行いません。
                        本ツールによる Google API から受け取った情報の使用および他のアプリへの転送は、
                        <a
                            className="text-green-700 underline"
                            href="https://developers.google.com/terms/api-services-user-data-policy"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Google API サービスのユーザーデータに関するポリシー
                        </a>
                        （限定的使用の要件を含む）に従います。
                    </p>
                </section>

                <section className="space-y-2">
                    <h2 className="text-lg font-semibold text-gray-900">3. 連携の解除と削除</h2>
                    <p>
                        本ツールの「面談の日程調整」画面で Googleカレンダーとの連携を解除すると、Google 側の許可を取り消し、保存していた接続情報を削除します。
                        Google アカウントの設定（
                        <a className="text-green-700 underline" href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">
                            サードパーティ製のアプリとサービス
                        </a>
                        ）からも、いつでも取り消せます。
                    </p>
                </section>

                <section className="space-y-2">
                    <h2 className="text-lg font-semibold text-gray-900">4. お問い合わせ</h2>
                    <p>本ツールでの情報の扱いについては、やりとりしている LINE 公式アカウントへメッセージでお問い合わせください。</p>
                </section>

                <footer className="border-t pt-4 text-xs text-gray-500">制定日: 2026年10月1日</footer>
            </article>
        </main>
    )
}
