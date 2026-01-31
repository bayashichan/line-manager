
# プロジェクト構成と役割分担

現在、このプロジェクトでは複数のクラウドサービスを適材適所で組み合わせて使用しています。
一見複雑に見えますが、**「コンポーザブル（構成可能）」なアーキテクチャ**と呼ばれる現代的な構成で、それぞれの得意分野を担当させています。

## 🏗️ 全体アーキテクチャ図

```mermaid
graph TD
    User(ユーザー/管理者) -->|アクセス| Vercel[Vercel (Next.js)]
    LINE(LINE Platform) -->|Webhook| Cloudflare[Cloudflare Workers]
    
    subgraph Frontend_Backend [アプリケーション層]
    Vercel -->|DB操作| Supabase_DB[(Supabase Database)]
    Vercel -->|画像保存| Cloudflare_R2[Cloudflare R2]
    Vercel -->|メッセージ送信| LINE
    end

    subgraph Middleware [中継層]
    Cloudflare -->|転送| Vercel
    Cloudflare -->|転送| LMessage[LMessage (外部ツール)]
    end

    subgraph Data [データ層]
    Supabase_DB
    Cloudflare_R2
    Supabase_Auth[Supabase Auth]
    Vercel -->|認証| Supabase_Auth
    end
```

## 🧩 各サービスの役割

### 1. Vercel (Next.js)
**役割: 「お店」と「工場」 (メインアプリケーション)**
- **Web画面**: 管理画面の表示、操作などのフロントエンド。
- **APIサーバー**: データベースとのやり取り、LINEへのメッセージ送信指示などを行うバックエンド処理。
- **Cron**: 定期的なステップ配信のトリガー。

### 2. Supabase
**役割: 「金庫」と「台帳」 (データベース & 認証)**
- **PostgreSQL**: 友だちデータ、メッセージ履歴、タグ情報などを保存するメインデータベース。
- **Auth**: 管理者のログイン認証管理。
- **Realtime**: チャットのリアルタイム更新（相手からメッセージが来た瞬間に画面を更新する機能）。

### 3. Cloudflare
**役割: 「倉庫」と「郵便局」**
- **R2 (Object Storage)**:「倉庫」。画像や動画などの大容量ファイルを保存します。Supabaseにもストレージはありますが、R2の方が安価でLINEからの大量アクセスに強いため採用しています。
- **Workers**: 「郵便局」。LINEから送られてくるWebhook（メッセージ通知）を最初に受け取り、このアプリ(Vercel)とLMessageの両方に振り分けて配送します。

### 4. GitHub
**役割: 「設計図置き場」**
- プロジェクトのソースコード履歴を管理・保存する場所。Vercelと連携し、GitHubに変更をプッシュすると自動的に本番環境(Vercel)が更新されます。

---

## 🛠️ なぜ Cloudflare R2 を使うのか？
LINEで動画や画像を送信する場合、LINEのサーバーからファイルへのアクセスが発生します。
Supabase Storageは転送量課金が発生しやすいため、**転送量無料（Egress Free）**であるCloudflare R2を使うことで、将来的なコストを大幅に抑えることができます。
