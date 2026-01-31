# 初期設定ガイド

## 1. Supabaseプロジェクトの準備
まず、データベースとなるSupabaseのプロジェクトを作成します。

1.  **Supabaseにログイン**: [https://supabase.com/dashboard](https://supabase.com/dashboard) にアクセスし、「New project」をクリックします。
2.  **プロジェクト作成**:
    -   **Name**: `LineManager` （好きな名前でOK）
    -   **Database Password**: **重要！** 設定したパスワードを忘れないようにメモしてください。
    -   **Region**: `Tokyo (ap-northeast-1)` を選択。
    -   「Create new project」をクリック。
3.  **設定値の取得**:
    -   プロジェクトのダッシュボードが開いたら、「Project Settings (歯車アイコン)」→「API」に進みます。
    -   以下の2つの値をコピーして手元に控えてください。
        -   **Project URL**: `https://xxxxxxxx.supabase.co` のようなURL
        -   **Project API keys (anon / public)**: `eyJhbGcF...` から始まる長い文字列

## 2. 環境変数の設定
プロジェクトフォルダに設定ファイルを作成します。

1.  プロジェクトフォルダ（`line-manager`）直下に `.env.local` という名前のファイルを作成します。
2.  以下の内容をコピーし、先ほど取得した値に書き換えて保存してください。

```bash
# Supabase設定
NEXT_PUBLIC_SUPABASE_URL=あなたのProject_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=あなたのanon_key

# LINEチャネル設定（後ほど設定しますが、枠だけ作っておきます）
# チャンネルごとの設定はDBに保存されるため、ここは空でも動作します
```

## 3. データベースの構築
設定ができたら、テーブルを作成します。私（AI）がコマンドを実行して行いますので、上記2ステップが完了したら教えてください。
