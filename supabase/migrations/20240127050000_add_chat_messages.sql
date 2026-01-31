-- ============================================================
-- 1:1チャット機能用 マイグレーション
-- ============================================================

-- 1. chat_messages テーブル作成
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    line_user_id UUID NOT NULL REFERENCES line_users(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('user', 'admin')), -- 送信者（ユーザー or 管理者）
    content_type TEXT NOT NULL DEFAULT 'text', -- text, image, sticker, etc.
    content JSONB NOT NULL, -- メッセージ本体
    read_at TIMESTAMPTZ, -- 既読日時（nullなら未読）
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- RLS有効化
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_id ON chat_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_line_user_id ON chat_messages(line_user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);

-- ポリシー設定（管理者メンバー向け）
CREATE POLICY "メンバーはチャットを参照可能" ON chat_messages
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = chat_messages.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーはチャットを送信可能" ON chat_messages
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = chat_messages.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーはチャットを更新可能" ON chat_messages
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = chat_messages.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

-- 2. line_users テーブル拡張
-- チャットリストの表示順序や未読バッジ用
ALTER TABLE line_users ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
ALTER TABLE line_users ADD COLUMN IF NOT EXISTS unread_count INT DEFAULT 0;

-- 3. Supabase Realtime 有効化
-- フロントエンドでリアルタイム受信するために必要
BEGIN;
  -- publicationが存在しない場合に備えて確認（通常はsupabase_realtimeがあるはず）
  -- 既存のpublicationにテーブルを追加
  ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
EXCEPTION
  WHEN undefined_object THEN
    NULL; -- publicationがない場合は無視（通常ありえないが安全のため）
END;
