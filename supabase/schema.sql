-- =============================================================================
-- LINE公式アカウント管理ツール - データベーススキーマ
-- Supabase (PostgreSQL) 用
-- =============================================================================

-- 拡張機能を有効化
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- 1. profiles（管理ユーザー情報）
-- Supabase Authと連携
-- =============================================================================
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- RLS有効化
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- プロフィール用ポリシー
CREATE POLICY "ユーザーは自分のプロフィールを参照可能" ON profiles
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "ユーザーは自分のプロフィールを更新可能" ON profiles
    FOR UPDATE USING (auth.uid() = id);

-- 新規ユーザー作成時にプロフィールを自動作成するトリガー
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, display_name)
    VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- =============================================================================
-- 2. channels（LINE公式アカウント情報）
-- =============================================================================
CREATE TABLE channels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_secret TEXT NOT NULL, -- 暗号化推奨
    channel_access_token TEXT NOT NULL, -- 暗号化推奨
    webhook_url TEXT,
    default_rich_menu_id UUID, -- 後でrich_menusテーブル作成後に外部キー追加
    auto_reply_tags UUID[], -- 友だち追加時に自動付与するタグID
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    UNIQUE(channel_id)
);

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 3. channel_members（チャンネル×ユーザー中間テーブル）
-- =============================================================================
CREATE TABLE channel_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    UNIQUE(channel_id, profile_id)
);

ALTER TABLE channel_members ENABLE ROW LEVEL SECURITY;

-- メンバーはアクセス可能なチャンネルのみ参照可能
CREATE POLICY "メンバーはチャンネルを参照可能" ON channels
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = channels.id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "オーナーはチャンネルを更新可能" ON channels
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = channels.id
            AND channel_members.profile_id = auth.uid()
            AND channel_members.role = 'owner'
        )
    );

CREATE POLICY "認証ユーザーはチャンネルを作成可能" ON channels
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "メンバーは自分のメンバーシップを参照可能" ON channel_members
    FOR SELECT USING (profile_id = auth.uid());

CREATE POLICY "オーナーはメンバーを管理可能" ON channel_members
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM channel_members cm
            WHERE cm.channel_id = channel_members.channel_id
            AND cm.profile_id = auth.uid()
            AND cm.role = 'owner'
        )
    );

-- =============================================================================
-- 4. rich_menus（リッチメニュー情報）
-- =============================================================================
CREATE TABLE rich_menus (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    rich_menu_id TEXT, -- LINE API発行のリッチメニューID
    name TEXT NOT NULL,
    image_url TEXT,
    areas JSONB DEFAULT '[]'::jsonb, -- タップ領域設定
    is_default BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE rich_menus ENABLE ROW LEVEL SECURITY;

-- channels.default_rich_menu_id の外部キー追加
ALTER TABLE channels
    ADD CONSTRAINT fk_default_rich_menu
    FOREIGN KEY (default_rich_menu_id)
    REFERENCES rich_menus(id)
    ON DELETE SET NULL;

CREATE POLICY "メンバーはリッチメニューを参照可能" ON rich_menus
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = rich_menus.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーはリッチメニューを作成可能" ON rich_menus
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = rich_menus.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーはリッチメニューを更新可能" ON rich_menus
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = rich_menus.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

-- =============================================================================
-- 5. tags（タグ定義）
-- =============================================================================
CREATE TABLE tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#3B82F6', -- デフォルト青
    linked_rich_menu_id UUID REFERENCES rich_menus(id) ON DELETE SET NULL,
    priority INT DEFAULT 0, -- 数字が大きいほど優先
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    UNIQUE(channel_id, name)
);

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "メンバーはタグを参照可能" ON tags
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = tags.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーはタグを管理可能" ON tags
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = tags.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

-- =============================================================================
-- 6. line_users（LINE友だち情報）
-- =============================================================================
CREATE TABLE line_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    line_user_id TEXT NOT NULL,
    display_name TEXT,
    internal_name TEXT, -- 管理用ネーム
    picture_url TEXT,
    status_message TEXT,
    is_blocked BOOLEAN DEFAULT FALSE,
    current_rich_menu_id UUID REFERENCES rich_menus(id) ON DELETE SET NULL,
    followed_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    UNIQUE(channel_id, line_user_id)
);

ALTER TABLE line_users ENABLE ROW LEVEL SECURITY;

-- インデックス
CREATE INDEX idx_line_users_channel_id ON line_users(channel_id);
CREATE INDEX idx_line_users_line_user_id ON line_users(line_user_id);

CREATE POLICY "メンバーは友だち情報を参照可能" ON line_users
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = line_users.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーは友だち情報を管理可能" ON line_users
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = line_users.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

-- =============================================================================
-- 7. line_user_tags（ユーザー×タグ中間テーブル）
-- =============================================================================
CREATE TABLE line_user_tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    line_user_id UUID NOT NULL REFERENCES line_users(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    UNIQUE(line_user_id, tag_id)
);

ALTER TABLE line_user_tags ENABLE ROW LEVEL SECURITY;

-- インデックス
CREATE INDEX idx_line_user_tags_line_user_id ON line_user_tags(line_user_id);
CREATE INDEX idx_line_user_tags_tag_id ON line_user_tags(tag_id);

CREATE POLICY "メンバーはタグ付けを参照可能" ON line_user_tags
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM line_users lu
            JOIN channel_members cm ON cm.channel_id = lu.channel_id
            WHERE lu.id = line_user_tags.line_user_id
            AND cm.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーはタグ付けを管理可能" ON line_user_tags
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM line_users lu
            JOIN channel_members cm ON cm.channel_id = lu.channel_id
            WHERE lu.id = line_user_tags.line_user_id
            AND cm.profile_id = auth.uid()
        )
    );

-- =============================================================================
-- 8. messages（配信履歴）
-- =============================================================================
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content JSONB NOT NULL, -- メッセージ内容（複数メッセージ対応）
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
    filter_tags UUID[], -- 配信対象タグID配列
    scheduled_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    total_recipients INT DEFAULT 0,
    success_count INT DEFAULT 0,
    failure_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_messages_channel_id ON messages(channel_id);
CREATE INDEX idx_messages_status ON messages(status);

CREATE POLICY "メンバーはメッセージを参照可能" ON messages
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = messages.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーはメッセージを管理可能" ON messages
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = messages.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

-- =============================================================================
-- 9. message_recipients（配信対象者）
-- =============================================================================
CREATE TABLE message_recipients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    line_user_id UUID NOT NULL REFERENCES line_users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    error_message TEXT,
    sent_at TIMESTAMPTZ
);

ALTER TABLE message_recipients ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_message_recipients_message_id ON message_recipients(message_id);
CREATE INDEX idx_message_recipients_status ON message_recipients(status);

CREATE POLICY "メンバーは配信対象者を参照可能" ON message_recipients
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM messages m
            JOIN channel_members cm ON cm.channel_id = m.channel_id
            WHERE m.id = message_recipients.message_id
            AND cm.profile_id = auth.uid()
        )
    );

-- =============================================================================
-- 10. step_scenarios（ステップ配信シナリオ）
-- =============================================================================
CREATE TABLE step_scenarios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK (trigger_type IN ('follow', 'tag_assigned')),
    trigger_tag_id UUID REFERENCES tags(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE step_scenarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "メンバーはシナリオを参照可能" ON step_scenarios
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = step_scenarios.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーはシナリオを管理可能" ON step_scenarios
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = step_scenarios.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

-- =============================================================================
-- 11. step_messages（ステップメッセージ）
-- =============================================================================
CREATE TABLE step_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scenario_id UUID NOT NULL REFERENCES step_scenarios(id) ON DELETE CASCADE,
    step_order INT NOT NULL,
    delay_minutes INT NOT NULL DEFAULT 0, -- 前ステップからの遅延（分）
    content JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    UNIQUE(scenario_id, step_order)
);

ALTER TABLE step_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "メンバーはステップメッセージを参照可能" ON step_messages
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM step_scenarios ss
            JOIN channel_members cm ON cm.channel_id = ss.channel_id
            WHERE ss.id = step_messages.scenario_id
            AND cm.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーはステップメッセージを管理可能" ON step_messages
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM step_scenarios ss
            JOIN channel_members cm ON cm.channel_id = ss.channel_id
            WHERE ss.id = step_messages.scenario_id
            AND cm.profile_id = auth.uid()
        )
    );

-- =============================================================================
-- 12. step_executions（ステップ配信実行状況）
-- =============================================================================
CREATE TABLE step_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scenario_id UUID NOT NULL REFERENCES step_scenarios(id) ON DELETE CASCADE,
    line_user_id UUID NOT NULL REFERENCES line_users(id) ON DELETE CASCADE,
    current_step INT NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
    next_send_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    
    UNIQUE(scenario_id, line_user_id)
);

ALTER TABLE step_executions ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_step_executions_next_send_at ON step_executions(next_send_at) WHERE status = 'active';

CREATE POLICY "メンバーは実行状況を参照可能" ON step_executions
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM step_scenarios ss
            JOIN channel_members cm ON cm.channel_id = ss.channel_id
            WHERE ss.id = step_executions.scenario_id
            AND cm.profile_id = auth.uid()
        )
    );

-- =============================================================================
-- 更新日時自動更新用トリガー
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 各テーブルにトリガー適用
CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_channels_updated_at
    BEFORE UPDATE ON channels
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_rich_menus_updated_at
    BEFORE UPDATE ON rich_menus
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_tags_updated_at
    BEFORE UPDATE ON tags
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_line_users_updated_at
    BEFORE UPDATE ON line_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_messages_updated_at
    BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_step_scenarios_updated_at
    BEFORE UPDATE ON step_scenarios
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_step_messages_updated_at
    BEFORE UPDATE ON step_messages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================================================
-- タグ付与時のリッチメニュー自動切り替え用関数
-- =============================================================================
CREATE OR REPLACE FUNCTION determine_rich_menu_for_user(p_line_user_id UUID)
RETURNS UUID AS $$
DECLARE
    v_rich_menu_id UUID;
    v_channel_id UUID;
BEGIN
    -- ユーザーのチャンネルIDを取得
    SELECT channel_id INTO v_channel_id
    FROM line_users
    WHERE id = p_line_user_id;

    -- 優先度が最も高いタグに連動するリッチメニューを取得
    SELECT t.linked_rich_menu_id INTO v_rich_menu_id
    FROM line_user_tags lut
    JOIN tags t ON t.id = lut.tag_id
    WHERE lut.line_user_id = p_line_user_id
      AND t.linked_rich_menu_id IS NOT NULL
    ORDER BY t.priority DESC
    LIMIT 1;

    -- なければデフォルトリッチメニューを返す
    IF v_rich_menu_id IS NULL THEN
        SELECT default_rich_menu_id INTO v_rich_menu_id
        FROM channels
        WHERE id = v_channel_id;
    END IF;

    RETURN v_rich_menu_id;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- コメント追加（テーブル説明）
-- =============================================================================
COMMENT ON TABLE profiles IS '管理画面ユーザー情報（Supabase Auth連携）';
COMMENT ON TABLE channels IS 'LINE公式アカウント情報';
COMMENT ON TABLE channel_members IS 'チャンネル×ユーザー関連（権限管理）';
COMMENT ON TABLE rich_menus IS 'リッチメニュー情報';
COMMENT ON TABLE tags IS 'タグ定義（リッチメニュー連動設定含む）';
COMMENT ON TABLE line_users IS 'LINE友だち情報';
COMMENT ON TABLE line_user_tags IS 'ユーザー×タグ中間テーブル';
COMMENT ON TABLE messages IS '配信履歴';
COMMENT ON TABLE message_recipients IS '配信対象者（個別ステータス管理）';
COMMENT ON TABLE step_scenarios IS 'ステップ配信シナリオ定義';
COMMENT ON TABLE step_messages IS 'ステップ配信の各メッセージ';
COMMENT ON TABLE step_executions IS 'ステップ配信実行状況';

-- =============================================================================
-- 13. activity_logs（操作ログ）
-- =============================================================================
CREATE TABLE activity_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    action TEXT NOT NULL, -- 'message.send', 'tag.create', 'rich_menu.register' など
    resource_type TEXT, -- 'message', 'tag', 'rich_menu', 'line_user' など
    resource_id UUID,
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_activity_logs_channel_id ON activity_logs(channel_id);
CREATE INDEX idx_activity_logs_created_at ON activity_logs(created_at);

CREATE POLICY "メンバーはログを参照可能" ON activity_logs
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = activity_logs.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

CREATE POLICY "メンバーはログを作成可能" ON activity_logs
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = activity_logs.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );

COMMENT ON TABLE activity_logs IS '操作ログ（監査証跡）';

