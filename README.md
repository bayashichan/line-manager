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
