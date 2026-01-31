# LINE Webhook Proxy Server

LINE公式アカウントからのWebhookを受け取り、複数のサービス（Lメッセージ、自作アプリ）へ転送するCloudflare Workerです。

## 準備

1.  **Cloudflareアカウントの作成**: https://dash.cloudflare.com/sign-up
2.  **Wrangler (CLI) のインストール**:
    ```bash
    npm install -g wrangler
    ```
3.  **ログイン**:
    ```bash
    wrangler login
    ```

## 設定

`wrangler.toml` ファイルの `[vars]` セクション、またはデプロイ後のCloudflareダッシュボードで以下の環境変数を設定してください。

-   `L_MESSAGE_WEBHOOK_URL`: LメッセージのWebhook URL
-   `MY_APP_WEBHOOK_URL`: 自作アプリのWebhook URL (例: `https://your-app.vercel.app/api/webhook/line`)

## ローカル開発

```bash
cd webhook-proxy
npm install
npx wrangler dev
```

## デプロイ

```bash
cd webhook-proxy
npx wrangler deploy
```

デプロイが完了すると、`https://line-webhook-proxy.<あなたのサブドメイン>.workers.dev` というURLが発行されます。
このURLをLINE DevelopersのWebhook URLに設定してください。
