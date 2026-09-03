-- ============================================================
-- 既読管理（みなし既読）と配信元の記録
-- ============================================================
--
-- 【前提】LINE Messaging API は「既読」を一切通知しない。
--   - 既読を知らせるWebhookイベントは存在しない
--   - 送信済みメッセージの既読状態を取得するAPIも存在しない
-- そのため本システムでは「みなし既読」を採用する。
--   友だちから何らかの反応（メッセージ送信・ボタンタップ・配信内リンクのタップ）が
--   あった時点で、それ以前にこちらから送ったメッセージはトーク画面で目に入っている
--   ものとして既読扱いにする。read_source にどの反応を根拠にしたかを残す。
--
-- 同様に、LINE公式アカウントアプリ（純正アプリ）からオペレーターが送った
-- メッセージを取得するAPIも存在しない。1:1チャットを実際のトークに近づけるため、
-- 本システム経由の送信（チャット／一斉配信／ステップ配信／自動応答）はすべて
-- chat_messages に記録し、どの経路で送られたかを delivery_source で判別できるようにする。

-- ------------------------------------------------------------
-- 1. chat_messages: 配信元と既読の根拠を記録
-- ------------------------------------------------------------
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS delivery_source TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS read_source TEXT;
-- LINE側のメッセージID。受信メッセージの重複保存防止と、送信取消(unsend)の突き合わせに使う
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS line_message_id TEXT;
-- 友だちが送信を取り消したメッセージ（本文は残さずグレー表示にする）
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS unsent_at TIMESTAMPTZ;

COMMENT ON COLUMN chat_messages.delivery_source IS '管理者側: chat | broadcast | step | auto_reply / 友だち側: line';
COMMENT ON COLUMN chat_messages.read_source IS 'みなし既読の根拠: message | postback | link_click | other';

-- トーク表示（line_user_id + created_at 順）を高速化
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
    ON chat_messages(line_user_id, created_at);

-- 未読の管理者メッセージだけを引くための部分インデックス
CREATE INDEX IF NOT EXISTS idx_chat_messages_unread_admin
    ON chat_messages(line_user_id)
    WHERE sender = 'admin' AND read_at IS NULL;

-- 同じLINEメッセージIDを二重に保存しない（Webhookは再送されることがある）
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_line_message_id
    ON chat_messages(channel_id, line_message_id)
    WHERE line_message_id IS NOT NULL;

-- 一斉配信の既読状況を配信IDから引くため
CREATE INDEX IF NOT EXISTS idx_chat_messages_message_id
    ON chat_messages(message_id)
    WHERE message_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. line_users: 友だちが最後にトークを開いたと推定できる日時
-- ------------------------------------------------------------
ALTER TABLE line_users ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
COMMENT ON COLUMN line_users.last_read_at IS 'みなし既読の基準時刻。この時刻以前に送ったメッセージは既読扱い';

-- ------------------------------------------------------------
-- 3. message_recipients: 配信ごと・友だちごとの到達／既読状況
-- ------------------------------------------------------------
ALTER TABLE message_recipients ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE message_recipients ADD COLUMN IF NOT EXISTS read_source TEXT;

-- 再送・再実行で同じ配信に同じ友だちの行が増えないようにする
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_recipients_message_user
    ON message_recipients(message_id, line_user_id);

CREATE INDEX IF NOT EXISTS idx_message_recipients_line_user_id
    ON message_recipients(line_user_id);

-- 未読の配信対象だけを引くための部分インデックス
CREATE INDEX IF NOT EXISTS idx_message_recipients_unread
    ON message_recipients(line_user_id)
    WHERE read_at IS NULL;

-- 既存の配信履歴には対象者行が無いため、一覧では「記録なし」として扱う。
-- 遡って作ると誰に届いたのか分からないまま行だけ増えるので、あえて埋めない。
