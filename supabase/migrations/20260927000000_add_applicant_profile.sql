-- =============================================================================
-- applicants: 申込者の友だち情報へ反映する内容（管理用ネーム・タグ）
--
-- 申込フォームから「管理用ネームに登録する名前（例: 出展名）」と
-- 「付与するタグ名（例: 第7回出展者）」を受け取り、友だちに反映する。
--
-- 友だちなら申込の連携時にその場で反映するが、未友だちの人は line_users の行が
-- まだ無いため反映できない。そこでここに控えておき、友だち追加（Webhook）の
-- タイミングで反映する。反映済みかどうかは profile_applied_at で判定する。
-- =============================================================================

ALTER TABLE applicants
    ADD COLUMN IF NOT EXISTS internal_name TEXT,
    ADD COLUMN IF NOT EXISTS tag_names TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS profile_applied_at TIMESTAMPTZ;

-- 既存の行は反映するものが無いので、反映済みとして扱う
UPDATE applicants SET profile_applied_at = created_at WHERE profile_applied_at IS NULL;

-- Webhook（友だち追加・メッセージ受信）のたびに未反映の申込を探すため
CREATE INDEX IF NOT EXISTS idx_applicants_pending_profile
    ON applicants(channel_id, line_user_id)
    WHERE profile_applied_at IS NULL;

COMMENT ON COLUMN applicants.internal_name IS '友だちの管理用ネームに登録する名前（出展名など）';
COMMENT ON COLUMN applicants.tag_names IS '友だちに付与するタグ名。無いタグは作成する';
COMMENT ON COLUMN applicants.profile_applied_at IS 'internal_name / tag_names を友だちへ反映した日時。NULL = 未反映（未友だち）';
