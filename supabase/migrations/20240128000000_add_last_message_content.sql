
-- line_usersテーブルにlast_message_contentカラムを追加
ALTER TABLE line_users ADD COLUMN IF NOT EXISTS last_message_content TEXT;

-- 既存のデータに対して、最新のメッセージ内容を埋める
UPDATE line_users lu
SET last_message_content = (
  SELECT 
    CASE 
      WHEN content_type = 'text' THEN content->>'text'
      WHEN content_type = 'image' THEN '画像が送信されました'
      WHEN content_type = 'video' THEN '動画が送信されました'
      ELSE 'メッセージが送信されました'
    END
  FROM chat_messages cm
  WHERE cm.line_user_id = lu.id
  ORDER BY created_at DESC
  LIMIT 1
);
