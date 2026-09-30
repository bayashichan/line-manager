# AIエージェント連携（MCP）のセットアップ

Claude（claude.ai / デスクトップアプリ / スマホアプリ / Claude Code）から、
話し言葉でステップ配信を作れるようにする機能です。
L Harness の MCP サーバー（`@line-harness/mcp-server`）と同じ考え方を、このツールの構成（Vercel + Supabase）に合わせて実装しています。

```
Claude ──(MCP)──▶ https://<このツールのURL>/api/mcp ──▶ Supabase（step_scenarios / step_messages）
   └─ 初回だけ「許可」画面（/oauth/authorize）でこのツールにログインして接続を許可
```

## できること

| ツール | 内容 |
|---|---|
| `list_channels` | 操作できるLINE公式アカウントの一覧（友だち数・ステップ配信数） |
| `list_tags` | タグ一覧（タグ付与で始まるステップ配信を作るとき用） |
| `list_step_scenarios` / `get_step_scenario` | ステップ配信の一覧・詳細（全文と配信スケジュール） |
| `create_step_scenario` | ステップ配信を作成（**オフ＝下書きで保存**。この時点では誰にも送られない） |
| `update_step_scenario` | 名前・開始条件・ステップを変更 |
| `set_step_scenario_active` | オン（配信開始）/ オフ |
| `delete_step_scenario` | 削除 |
| `search_friends` / `send_test_message` | 自分のLINEを探して1ステップをテスト送信（送信枠を1通消費） |

一斉配信のツールはありません。AIが勝手に大勢へ送ることはできない設計です。
操作は「操作ログ」（`activity_logs`、`details.via = "mcp"`）に残ります。

## セットアップ（最初の1回だけ）

### 1. Supabase にテーブルを追加する

Supabase の SQL Editor で
[`supabase/migrations/20260929000000_add_mcp_oauth.sql`](../supabase/migrations/20260929000000_add_mcp_oauth.sql)
の中身を実行します（接続の許可・トークンを保存するテーブル3つ）。

### 2. デプロイする

このブランチを本番（Vercel）に反映します。追加の環境変数は基本的に不要です。

| 環境変数 | 必須 | 説明 |
|---|---|---|
| `MCP_BASE_URL` | 任意 | 接続URLのホストを固定したい場合（例: 独自ドメイン `https://line.example.com`）。未設定ならアクセスされたホストを使う |
| `MCP_ALLOWED_REDIRECT_URIS` | 任意 | Claude 以外のMCPクライアントも使う場合に、その戻り先URLをカンマ区切りで許可 |

### 3. Claude にコネクタを追加する

**claude.ai / デスクトップ / スマホ（Pro・Max など個人プラン）**

1. claude.ai で **Customize > Connectors** を開く
2. **Add custom connector** をクリック
3. URL に `https://<このツールのURL>/api/mcp` を入力（例: `https://line-manager-omega.vercel.app/api/mcp`）
4. 認証の選択肢が出たら、**Sign in now** と **Register automatically**（自動登録）を選ぶ
5. **Add** → **Connect** を押すと、このツールの「接続を許可しますか？」画面が開く
6. ログインして内容を確認し、**許可する** を押す

Team / Enterprise プランでは、組織のオーナーが **Organization settings > Connectors** で追加し、各メンバーが **Connect** します。
一度追加すると、同じアカウントのデスクトップアプリ・スマホアプリでも使えます。

**Claude Code**

```bash
claude mcp add --transport http line-manager https://<このツールのURL>/api/mcp
```

Claude Code の中で `/mcp` を実行し、`line-manager` を選んで認証すると、ブラウザで同じ許可画面が開きます。

### 4. ステップ配信を動かす頻度を上げる（重要）

ステップ配信は `/api/cron/step-messages` が呼ばれたときに送信されます。
いまの `vercel.json` の設定は **1日1回（日本時間 9:00）** です。このままだと「当日20:00」「30分後」などの配信は、翌朝9時にまとめて送られます。

どちらかで、数分おきに呼ばれるようにしてください。

- **Upstash QStash のスケジュール（おすすめ・既に契約済みのサービス）**
  1. Upstash Console → QStash → **Schedules** → **Create Schedule**
  2. Destination: `https://<このツールのURL>/api/cron/step-messages`
  3. Cron: `*/5 * * * *`（5分ごと）
  4. Method: `GET`
  5. Headers: `Authorization: Bearer <Vercel に設定している CRON_SECRET の値>`
- **Vercel Pro プラン**なら `vercel.json` の `step-messages` の `schedule` を `*/5 * * * *` などに変更

1回の実行で最大50件を送るため、5分ごとなら1日あたり最大14,400件まで処理できます。

## 使い方の例

コネクタを有効にした会話で、たとえば次のように頼みます。

> セミナー申込者向けのフォロー配信を作って。タグ「セミナー申込」が付いたら、
> 当日にお礼、前日20時にリマインド、翌日10時にアンケートのお願い。丁寧だけど堅すぎないトーンで。

AIは次の流れで進めます。

1. 現状（アカウント・タグ・既存のステップ配信）を確認する
2. 各ステップのタイミングと文面の案を出して、あなたの確認をとる
3. オフの状態で保存し、配信スケジュールと全文を見せる
4. 希望すれば、あなたのLINEにテスト送信する
5. 「オンにして」と指示したときだけ配信を始める

管理画面（ステップ配信）でも同じシナリオを確認・編集できます。

## 安全の仕組み

- **本人確認**: 接続時に、このツールのアカウントでログインして「許可」した人のトークンだけを発行（OAuth 2.1 + PKCE）
- **範囲の制限**: 操作できるのは、許可した人がメンバーになっているLINE公式アカウントだけ
- **戻り先の制限**: トークンを受け取れるのは Claude（claude.ai / claude.com）と、手元のパソコン（Claude Code）だけ
- **保存方法**: トークンはハッシュ値だけを保存。アクセストークンは1時間、リフレッシュトークンは30日（使うたびに入れ替え）
- **下書き保存**: AIが作ったステップ配信はオフで保存。配信開始は明示的な指示が必要

### 接続を取り消すには

- Claude 側: **Customize > Connectors** でコネクタを **Remove**
- このツール側で全部無効にする（SQL Editor）:
  ```sql
  delete from mcp_oauth_tokens;            -- 全員分
  -- 特定の人だけ: delete from mcp_oauth_tokens where user_id = '<ユーザーID>';
  ```

## 開発者向けメモ

| ファイル | 役割 |
|---|---|
| `src/app/api/mcp/route.ts` | MCP エンドポイント（Streamable HTTP・ステートレス・JSON応答） |
| `src/lib/mcp/tools.ts` | ツールの定義と、所属チャンネルの確認 |
| `src/lib/mcp/step-scenario.ts` | AIの入力 → `step_messages` 行への変換（管理画面と同じ形） |
| `src/app/.well-known/*` | OAuth のメタデータ（RFC 9728 / RFC 8414） |
| `src/app/api/oauth/register`・`token` | 動的クライアント登録（RFC 7591）・トークン発行 |
| `src/app/oauth/authorize` | 同意画面（Server Action で許可・拒否） |
| `src/lib/mcp/oauth.ts`・`oauth-store.ts` | PKCE・戻り先の検証などの純粋関数 / DB 操作 |

テスト: `npm test`（vitest）。Claude 側の接続要件は
[Authentication for connectors](https://claude.com/docs/connectors/building/authentication) を参照。
