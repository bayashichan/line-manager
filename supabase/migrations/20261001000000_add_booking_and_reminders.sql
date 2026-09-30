-- =============================================================================
-- 面談の日程調整 と リマインダー配信
--
-- 【日程調整】友だちが「個別」などのキーワードを送ると、登録済みの空き枠から候補を
--   番号付きで自動返信する（下にタップで選べるボタンも付ける）。番号の返事で予約が
--   確定し、タグ付けとリマインダー登録まで自動で行う。返事がなければ1回だけ催促する。
--   返信は応答（Reply）API を使うので、送信枠を消費しない（催促とリマインダーはプッシュ）。
--
-- 【リマインダー】面談などの日時を基準に「3日前 20:00」「1時間前」「翌日 10:00」
--   のように決めたタイミングで自動送信する。ステップ配信（登録時点からの経過時間）
--   と違い、基準は「予定の日時」。
--
-- すべて追加のみ。既存のテーブルは変更しない。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- リマインダー（テンプレート）
-- -----------------------------------------------------------------------------
CREATE TABLE reminders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    -- 登録した時点で送信時刻を過ぎていたメッセージを、予定の前ならすぐ送るか
    -- （例: 2日後の面談に登録したとき「3日前の事前質問」をすぐ送る）
    send_missed BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE reminder_steps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reminder_id UUID NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    step_order INT NOT NULL,
    -- day_time: 予定日の N日前/後 の HH:MM（日本時間） / relative: 予定時刻の N分前/後
    timing_type TEXT NOT NULL CHECK (timing_type IN ('day_time', 'relative')),
    offset_days INT NOT NULL DEFAULT 0,        -- day_time 用。-3 = 3日前、0 = 当日、1 = 翌日
    send_hour INT CHECK (send_hour BETWEEN 0 AND 23),
    send_minute INT NOT NULL DEFAULT 0 CHECK (send_minute BETWEEN 0 AND 59),
    offset_minutes INT NOT NULL DEFAULT 0,     -- relative 用。-60 = 1時間前、30 = 30分後
    content JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_reminder_steps_reminder_id ON reminder_steps(reminder_id);

-- 友だちごとに登録したリマインダー（予定1件ぶん）
CREATE TABLE friend_reminders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    reminder_id UUID REFERENCES reminders(id) ON DELETE SET NULL,
    line_user_id UUID NOT NULL REFERENCES line_users(id) ON DELETE CASCADE,
    target_at TIMESTAMPTZ NOT NULL,            -- 予定の日時（面談の開始時刻など）
    label TEXT,                                -- 例: 「初回無料面談」
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'booking', 'mcp')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_friend_reminders_channel ON friend_reminders(channel_id, status, target_at);
CREATE INDEX idx_friend_reminders_line_user ON friend_reminders(line_user_id);

-- 送信予定（1通ずつ）。登録時点の文面を content に写しておき、あとでテンプレートを
-- 編集しても、すでに登録済みの予定の文面は変わらない。
CREATE TABLE reminder_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    friend_reminder_id UUID NOT NULL REFERENCES friend_reminders(id) ON DELETE CASCADE,
    step_id UUID REFERENCES reminder_steps(id) ON DELETE SET NULL,
    step_order INT NOT NULL,
    send_at TIMESTAMPTZ NOT NULL,
    content JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'cancelled')),
    sent_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_reminder_deliveries_due ON reminder_deliveries(send_at) WHERE status = 'pending';
CREATE INDEX idx_reminder_deliveries_friend_reminder ON reminder_deliveries(friend_reminder_id);

-- -----------------------------------------------------------------------------
-- 面談の日程調整
-- -----------------------------------------------------------------------------
CREATE TABLE booking_settings (
    channel_id UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    trigger_keywords TEXT[] NOT NULL DEFAULT ARRAY['個別'],
    offer_count INT NOT NULL DEFAULT 3 CHECK (offer_count BETWEEN 1 AND 10),
    min_lead_hours INT NOT NULL DEFAULT 12 CHECK (min_lead_hours >= 0),  -- 何時間後以降の枠を案内するか
    session_label TEXT NOT NULL DEFAULT '初回無料面談',
    intro_text TEXT NOT NULL DEFAULT E'{name}さん、ご連絡ありがとうございます！\n初回無料面談の候補日です。ご都合のよい番号を送ってください。',
    other_label TEXT NOT NULL DEFAULT '別の日程を希望',
    decline_label TEXT NOT NULL DEFAULT '今回は見送る',
    booked_text TEXT NOT NULL DEFAULT E'ありがとうございます！\n{日時} で承りました。\n当日までのご案内を順にお送りしますね。',
    other_text TEXT NOT NULL DEFAULT E'承知しました。\n別の候補をお送りしますので、少々お待ちください。',
    decline_text TEXT NOT NULL DEFAULT E'承知しました。\nまたご都合のよいときに「個別」と送ってください。',
    no_slots_text TEXT NOT NULL DEFAULT E'ご連絡ありがとうございます！\n候補日を確認してご連絡しますので、少々お待ちください。',
    taken_text TEXT NOT NULL DEFAULT E'申し訳ありません、その枠は先に埋まってしまいました。',
    nudge_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    nudge_after_hours INT NOT NULL DEFAULT 24 CHECK (nudge_after_hours BETWEEN 1 AND 720),
    nudge_text TEXT NOT NULL DEFAULT E'{name}さん、面談の日程はいかがでしょうか？\n番号を送るか、下のボタンをタップするだけで大丈夫です。',
    booked_tag_id UUID REFERENCES tags(id) ON DELETE SET NULL,
    reminder_id UUID REFERENCES reminders(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE booking_slots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    start_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booked', 'closed')),
    line_user_id UUID REFERENCES line_users(id) ON DELETE SET NULL,
    booked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

    UNIQUE (channel_id, start_at)
);

CREATE INDEX idx_booking_slots_open ON booking_slots(channel_id, start_at) WHERE status = 'open';

-- 候補を送った記録（誰に・どの枠を・どう答えたか）
CREATE TABLE booking_offers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    line_user_id UUID NOT NULL REFERENCES line_users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'booked', 'other', 'declined', 'no_slots', 'superseded', 'cancelled')),
    slot_ids UUID[] NOT NULL DEFAULT '{}',     -- 案内した枠（番号の順）
    booked_slot_id UUID REFERENCES booking_slots(id) ON DELETE SET NULL,
    friend_reminder_id UUID REFERENCES friend_reminders(id) ON DELETE SET NULL,
    responded_at TIMESTAMPTZ,                  -- 番号以外でも何か返事が来た時刻（催促を止める）
    nudged_at TIMESTAMPTZ,                     -- 催促した時刻（1回だけ）
    answered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_booking_offers_pending ON booking_offers(created_at) WHERE status = 'pending';
CREATE INDEX idx_booking_offers_friend ON booking_offers(line_user_id, created_at);

-- -----------------------------------------------------------------------------
-- RLS（チャンネルのメンバーだけが参照・管理できる）
-- -----------------------------------------------------------------------------
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE friend_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "メンバーはリマインダーを管理可能" ON reminders
    FOR ALL USING (EXISTS (
        SELECT 1 FROM channel_members cm
        WHERE cm.channel_id = reminders.channel_id AND cm.profile_id = auth.uid()
    ));

CREATE POLICY "メンバーはリマインダーのステップを管理可能" ON reminder_steps
    FOR ALL USING (EXISTS (
        SELECT 1 FROM reminders r
        JOIN channel_members cm ON cm.channel_id = r.channel_id
        WHERE r.id = reminder_steps.reminder_id AND cm.profile_id = auth.uid()
    ));

-- 友だちへの登録・送信予定は、送信の整合性を保つため API（サーバー）経由で作成・取消する。
-- 画面からは参照のみ。
CREATE POLICY "メンバーは登録済みリマインダーを参照可能" ON friend_reminders
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM channel_members cm
        WHERE cm.channel_id = friend_reminders.channel_id AND cm.profile_id = auth.uid()
    ));

CREATE POLICY "メンバーはリマインダーの送信予定を参照可能" ON reminder_deliveries
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM friend_reminders fr
        JOIN channel_members cm ON cm.channel_id = fr.channel_id
        WHERE fr.id = reminder_deliveries.friend_reminder_id AND cm.profile_id = auth.uid()
    ));

CREATE POLICY "メンバーは日程調整の設定を管理可能" ON booking_settings
    FOR ALL USING (EXISTS (
        SELECT 1 FROM channel_members cm
        WHERE cm.channel_id = booking_settings.channel_id AND cm.profile_id = auth.uid()
    ));

CREATE POLICY "メンバーは面談枠を管理可能" ON booking_slots
    FOR ALL USING (EXISTS (
        SELECT 1 FROM channel_members cm
        WHERE cm.channel_id = booking_slots.channel_id AND cm.profile_id = auth.uid()
    ));

CREATE POLICY "メンバーは日程のやりとりを参照可能" ON booking_offers
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM channel_members cm
        WHERE cm.channel_id = booking_offers.channel_id AND cm.profile_id = auth.uid()
    ));

COMMENT ON TABLE reminders IS 'リマインダー（予定の日時を基準にした配信のテンプレート）';
COMMENT ON TABLE reminder_steps IS 'リマインダーの各メッセージとタイミング';
COMMENT ON TABLE friend_reminders IS '友だちごとに登録したリマインダー（予定1件ぶん）';
COMMENT ON TABLE reminder_deliveries IS 'リマインダーの送信予定（1通ずつ）';
COMMENT ON TABLE booking_settings IS '面談の日程調整の設定（チャンネルごと）';
COMMENT ON TABLE booking_slots IS '面談の空き枠';
COMMENT ON TABLE booking_offers IS '面談の候補を送った記録';
