-- =============================================================================
-- applicants: 外部の申込フォームから連携された申込者
--
-- 背景:
-- 申込フォーム(LIFF)は LINEログインで userId を取得できるが、LINEログインは
-- 「認証」であって「友だち追加」ではない。userId が取れても、その人が公式
-- アカウントの友だちとは限らない。
--
-- 非友だちを line_users に入れると、配信対象に混ざって push が 403 で失敗し、
-- 友だち数や配信成功率の統計が壊れる。そのため申込者は必ずこのテーブルに記録し、
-- 友だちだと確認できた場合にのみ line_users 側にも作る。
-- =============================================================================

CREATE TABLE applicants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    line_user_id TEXT NOT NULL,                                      -- LINEのuserId（生の文字列）
    display_name TEXT,                                               -- 申込時点のLINE表示名
    source TEXT NOT NULL,                                            -- 申込元の識別子（例: buchiiyashi-apply）
    is_friend BOOLEAN NOT NULL DEFAULT FALSE,                        -- 連携時点で公式アカウントの友だちだったか
    linked_line_user_id UUID REFERENCES line_users(id) ON DELETE SET NULL,  -- 友だちの場合の内部UUID
    applied_at TIMESTAMPTZ,                                          -- 申込フォーム側の申込日時
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

    -- 同じ人が同じ申込元から複数回申し込む場合は行を増やさず更新する
    UNIQUE (channel_id, line_user_id, source)
);

ALTER TABLE applicants ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_applicants_channel_id ON applicants(channel_id);
CREATE INDEX idx_applicants_is_friend ON applicants(channel_id, is_friend);
CREATE INDEX idx_applicants_created_at ON applicants(created_at);

-- 書き込みはサービスロール(admin client)経由のみ。管理画面での閲覧用にSELECTのみ許可する。
CREATE POLICY "メンバーは申込者を参照可能" ON applicants
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = applicants.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE TRIGGER update_applicants_updated_at
    BEFORE UPDATE ON applicants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE applicants IS '外部申込フォームから連携された申込者（友だち判定つき）';
COMMENT ON COLUMN applicants.is_friend IS '連携時点で公式アカウントの友だちだったか。FALSE = 申込済みだが未友だち';
