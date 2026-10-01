-- =============================================================================
-- 1:1チャットの送信予約
--
-- チャット画面で書いたメッセージを、指定した日時に1人の友だちへ送る。
-- 予約した時刻になったら QStash（時刻ちょうど）と定期処理（/api/cron/tick、5分ごと）の
-- どちらかから送る（src/lib/messaging/scheduled-chat.ts）。1件ごとに「pending → sending」を
-- 1回の UPDATE で取り、取れた側だけが送るので、両方から呼ばれても送るのは1回だけ。
--
-- 追加のみ。既存のテーブルは変更しない。
-- =============================================================================

CREATE TABLE scheduled_chat_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    line_user_id UUID NOT NULL REFERENCES line_users(id) ON DELETE CASCADE,  -- line_users.id（内部ID）
    -- 送る内容（LINE のメッセージ配列。テキスト・画像・動画）。予約した時点の内容をそのまま送る
    content JSONB NOT NULL,
    send_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
    sent_at TIMESTAMPTZ,
    error_message TEXT,
    created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_scheduled_chat_messages_due ON scheduled_chat_messages(send_at) WHERE status = 'pending';
CREATE INDEX idx_scheduled_chat_messages_channel ON scheduled_chat_messages(channel_id, status);
CREATE INDEX idx_scheduled_chat_messages_line_user ON scheduled_chat_messages(line_user_id);

-- 予約・取り消しは、送信の整合性を保つため API（サーバー）経由で行う。画面からは参照のみ。
ALTER TABLE scheduled_chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "メンバーはチャットの送信予約を参照可能" ON scheduled_chat_messages
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM channel_members cm
        WHERE cm.channel_id = scheduled_chat_messages.channel_id AND cm.profile_id = auth.uid()
    ));

COMMENT ON TABLE scheduled_chat_messages IS '1:1チャットの送信予約（1回の予約ぶん）';
