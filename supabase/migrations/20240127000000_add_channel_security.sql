-- チャンネルテーブルにセキュリティ関連のカラムを追加

-- パスワードカラム（ハッシュ化して保存することを想定）
ALTER TABLE channels 
ADD COLUMN IF NOT EXISTS access_password TEXT;

-- 作成者カラム（誰がこのチャンネルを作成したか）
ALTER TABLE channels 
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id);

-- コメント追加
COMMENT ON COLUMN channels.access_password IS 'チャンネルアクセス用パスワード（ハッシュ値）';
COMMENT ON COLUMN channels.created_by IS 'チャンネル作成者のプロファイルID';
