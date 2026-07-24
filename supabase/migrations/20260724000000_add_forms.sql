-- =============================================================================
-- 申込フォーム機能
-- forms: フォーム定義 / form_responses: 回答
-- リッチメニュー(URIアクション/LIFF)から起動し、送信完了時に自動返信＋タグ付与を行う
-- =============================================================================

-- -----------------------------------------------------------------------------
-- forms: フォーム定義
-- -----------------------------------------------------------------------------
CREATE TABLE forms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                                  -- 管理用名称
    title TEXT,                                          -- 申込者に見せる見出し
    description TEXT,                                    -- 説明文
    fields JSONB NOT NULL DEFAULT '[]'::jsonb,           -- 項目定義 [{id,label,type,required,options,placeholder}]
    completion_message JSONB NOT NULL DEFAULT '[]'::jsonb, -- 完了時の自動返信（LINEメッセージ配列。テキスト/画像）
    completion_tag_ids UUID[],                           -- 完了時に付与するタグID
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE forms ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_forms_channel_id ON forms(channel_id);

CREATE POLICY "メンバーはフォームを参照可能" ON forms
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = forms.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーはフォームを管理可能" ON forms
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = forms.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE TRIGGER update_forms_updated_at
    BEFORE UPDATE ON forms
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -----------------------------------------------------------------------------
-- form_responses: 回答
-- 送信はサービスロール(admin client)経由で行うため、INSERTポリシーは不要
-- (service roleはRLSをバイパスする)。管理画面での閲覧用にSELECTのみ許可する。
-- -----------------------------------------------------------------------------
CREATE TABLE form_responses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    form_id UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    line_user_id UUID REFERENCES line_users(id) ON DELETE SET NULL,  -- 内部UUID（友だち未登録ならNULL）
    line_user_id_raw TEXT,                                            -- LINEのuserId
    answers JSONB NOT NULL DEFAULT '{}'::jsonb,                       -- {fieldId: value, ...}
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE form_responses ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_form_responses_form_id ON form_responses(form_id);
CREATE INDEX idx_form_responses_channel_id ON form_responses(channel_id);
CREATE INDEX idx_form_responses_created_at ON form_responses(created_at);

CREATE POLICY "メンバーは回答を参照可能" ON form_responses
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = form_responses.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

COMMENT ON TABLE forms IS '申込フォーム定義（リッチメニュー/LIFFから起動）';
COMMENT ON TABLE form_responses IS '申込フォームの回答';
