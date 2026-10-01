# LINE公式アカウント管理ツール

## 概要
LINE公式アカウントを一元管理するためのWebアプリケーションです。
複数のアカウント管理、友だち管理、タグ連動リッチメニュー切替、ステップ配信などの機能を提供します。

## 技術スタック
- **フロントエンド**: Next.js 15 (App Router, TypeScript)
- **スタイリング**: Tailwind CSS + Shadcn/ui
- **バックエンド/DB**: Supabase (PostgreSQL, Auth)
- **ファイル配信**: Cloudflare R2
- **ジョブキュー**: Upstash QStash
- **LINE連携**: LINE Messaging API

### ファイル配信について（重要）
画像・動画は必ず Cloudflare R2 に置く。Supabase Storage の公開URLは使わない。

LINEは配信のたびに `originalContentUrl` / `previewImageUrl` を受信者ぶん取得しにくるため、
Supabase の公開バケットを配信元にすると転送量(cached egress)が無料枠を超え、
`exceed_cached_egress_quota` でプロジェクトごと停止される（Auth も止まりログインできなくなる）。
R2 は egress が無料なのでこちらに統一している。

アップロードは共通ヘルパー経由で行う。
- クライアント: `uploadToR2()` (`src/lib/storage/upload-client.ts`)
- サーバー: `uploadToR2Server()` (`src/lib/storage/r2.ts`)

過去に Supabase Storage へ上げたアセットの移行は
`POST /api/admin/migrate-storage` で行う。オーナー権限でログイン済みの
セッション、または `MIGRATION_SECRET`（未設定なら `CRON_SECRET`）で認証する。

`CRON_SECRET` は QStash に登録済みの予約配信ジョブのヘッダーに焼き込まれて
いるため、値を作り直すと予約済みの配信が401で失敗する点に注意。

### AIエージェント連携（MCP）
Claude から話し言葉でステップ配信を作成・編集できる（`/api/mcp`）。
接続は OAuth（このツールにログインして「許可」）で、操作できるのは自分がメンバーのアカウントだけ。
AIが作ったステップ配信はオフ（下書き）で保存される。
セットアップと使い方は [docs/mcp-setup.md](docs/mcp-setup.md)。

### リッチメニューの出し分け
リッチメニュー画面の「誰に・どのメニューを見せるか」で、全員向け（基本のメニュー）とタグ別のメニューを選ぶと、
その場で LINE に反映される（LINE APIへの登録・解除の操作は不要）。

- 全員向け（基本のメニュー / 表示期間中のメニュー）は LINE の「デフォルトリッチメニュー」として設定し、
  一人ひとりには個別に付けない。LINE は個別に付けたメニューをデフォルトより優先するため、
  個別に付けるとデフォルトを変えても古いメニューのまま残ってしまう
- タグ別のメニューだけを、そのタグの人に個別に付ける（優先度が高いタグを優先）
- LINE のリッチメニューは作成後に中身を変えられないため、使用中のメニューを編集して保存すると
  LINE 上で作り直して付け替え、古い版を消す
- 表示期間の切り替えは定期処理（`/api/cron/tick`）で行う
- 表示がおかしいときは「LINEと揃え直す」を押すと、全員の表示を設定どおりに送り直す

### 面談の日程調整・リマインダー配信
「個別」と送ってきた人に空き枠から候補を自動返信し、番号で確定。確定後は事前質問・録音依頼・前日連絡などを
予定の日時を基準に自動送信する。定期処理（`/api/cron/tick`）を5分ごとに呼ぶ必要がある。
Googleカレンダーと連携すると、空き時間から枠を自動で作り、確定時に予定と Google Meet の URL を作成する（任意。`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` が必要）。
使い方は [docs/booking-and-reminders.md](docs/booking-and-reminders.md)。

### 1:1チャットの送信予約
チャット画面の時計ボタンを押すと、書いたメッセージ（テキスト・画像・動画）を指定した日時（日本時間）に送れる。
予約はトークの一番下に点線の吹き出しで表示され、送るまでは「取り消す」で止められる。
友だち一覧には予約がある人に時計マーク、送れなかった予約（ブロックされていた等）がある人に赤いマークが付く。

- 予約時に QStash（`QSTASH_TOKEN`）へジョブを登録し、時刻ちょうどに `/api/webhook/qstash-chat` から送る
- QStash が使えない・届かなかったときは定期処理（`/api/cron/tick`、5分ごと）が送る。どちらから呼ばれても送るのは1回だけ
- `supabase/migrations/20261004000000_add_scheduled_chat_messages.sql` の適用が必要

## セットアップ

### 1. 環境変数の設定
`.env.local.example` をコピーして `.env.local` を作成し、各値を設定してください。

```bash
cp .env.local.example .env.local
```

### 2. 依存関係のインストール
```bash
npm install
```

### 3. Supabaseのセットアップ
1. [Supabase](https://supabase.com) でプロジェクトを作成
2. `supabase/schema.sql` をSQLエディタで実行
3. 環境変数にSupabaseのURLとキーを設定

### 4. 開発サーバーの起動
```bash
npm run dev
```

ブラウザで http://localhost:3000 を開いてください。

## ディレクトリ構成
```
src/
├── app/                    # App Routerページ
│   ├── (auth)/            # 認証関連ページ
│   ├── (dashboard)/       # ダッシュボード
│   └── api/               # APIルート
├── components/            # UIコンポーネント
│   ├── ui/               # Shadcn/ui コンポーネント
│   └── ...               # カスタムコンポーネント
├── lib/                   # ユーティリティ
│   ├── supabase/         # Supabaseクライアント
│   └── line/             # LINE SDK
└── types/                 # 型定義
```

## 機能一覧
- [ ] マルチアカウント管理
- [ ] 友だち管理（タグ付け、管理用ネーム）
- [ ] リッチメニュー管理
- [ ] タグ連動リッチメニュー切替
- [ ] メッセージ配信（テキスト、画像、動画）
- [ ] セグメント配信
- [ ] ステップ配信

## ライセンス
MIT
