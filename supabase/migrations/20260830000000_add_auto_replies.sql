-- =============================================================================
-- キーワード自動応答機能
-- auto_replies: キーワードと応答内容の定義
--
-- 送信には Messaging API の応答（Reply）APIを使う。応答メッセージはLINEの
-- メッセージ通数にカウントされないため、この機能での返信は送信枠を消費しない。
-- （プッシュ/マルチキャストは課金対象なので、Webhookからは絶対にpushへ
--   フォールバックさせないこと。詳細は webhook/[channelId]/route.ts を参照）
-- =============================================================================

CREATE TABLE auto_replies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                                        -- 管理用名称
    keywords TEXT[] NOT NULL DEFAULT '{}',                     -- マッチさせる語（複数はOR条件）
    match_type TEXT NOT NULL DEFAULT 'partial'                 -- exact: 完全一致 / partial: 部分一致
        CHECK (match_type IN ('exact', 'partial')),
    content JSONB NOT NULL DEFAULT '[]'::jsonb,                -- 応答内容（LINEメッセージ配列。テキスト/画像）
    priority INT NOT NULL DEFAULT 0,                           -- 複数マッチ時の優先度（大きいほど優先）
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE auto_replies ENABLE ROW LEVEL SECURITY;

-- Webhookは有効な行だけをチャネル単位で引くため、その形でインデックスを張る
CREATE INDEX idx_auto_replies_channel_active ON auto_replies(channel_id, is_active);

CREATE POLICY "メンバーは自動応答を参照可能" ON auto_replies
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = auto_replies.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーは自動応答を管理可能" ON auto_replies
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = auto_replies.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE TRIGGER update_auto_replies_updated_at
    BEFORE UPDATE ON auto_replies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE auto_replies IS 'キーワード自動応答の定義。応答APIで返すため送信枠を消費しない';
COMMENT ON COLUMN auto_replies.keywords IS 'マッチさせる語。複数指定した場合はいずれか1つに一致すれば応答する';
COMMENT ON COLUMN auto_replies.priority IS '複数ルールがマッチしたときの優先度。大きいほど優先され、応答は必ず1件のみ';
