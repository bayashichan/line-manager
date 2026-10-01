-- =============================================================================
-- Googleカレンダー連携（面談の日程調整）
--
-- 申込者側の手順は増やさない（「個別」→ LINE で番号を選ぶ、のまま）。
-- カレンダーは担当者側だけで使う:
--   - 受付時間の中で、カレンダーに予定がない時間を面談の空き枠として自動で作る
--   - 予定が入った時間の枠は自動で締め切る（予定がなくなれば再開）
--   - 予約が確定したらカレンダーに予定を作り、Google Meet の URL を発行する
--   - 予約を取り消したらカレンダーの予定も消す
--
-- すべて追加のみ。既存の手動の空き枠はそのまま使える（初期値は手動）。
-- =============================================================================

-- 連携情報。トークンはサーバー（サービスロール）からしか触らない
CREATE TABLE google_calendar_connections (
    channel_id UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    google_email TEXT,
    calendar_id TEXT NOT NULL DEFAULT 'primary',
    refresh_token TEXT NOT NULL,
    access_token TEXT,
    access_token_expires_at TIMESTAMPTZ,
    connected_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    last_synced_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- ポリシーは作らない（ブラウザからは読めない。状態は API 経由で返す）
ALTER TABLE google_calendar_connections ENABLE ROW LEVEL SECURITY;

-- 空き枠の作り方と、カレンダーの予定の作り方
ALTER TABLE booking_settings
    ADD COLUMN slot_source TEXT NOT NULL DEFAULT 'manual' CHECK (slot_source IN ('manual', 'calendar')),
    -- 受付する曜日（0=日〜6=土）と時間帯（日本時間）
    ADD COLUMN availability JSONB NOT NULL DEFAULT '{"weekdays":[1,2,3,4,5],"start":"10:00","end":"18:00"}'::jsonb,
    ADD COLUMN slot_duration_minutes INT NOT NULL DEFAULT 60 CHECK (slot_duration_minutes BETWEEN 15 AND 480),
    ADD COLUMN slot_interval_minutes INT NOT NULL DEFAULT 60 CHECK (slot_interval_minutes BETWEEN 15 AND 480),
    ADD COLUMN buffer_minutes INT NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
    ADD COLUMN horizon_days INT NOT NULL DEFAULT 14 CHECK (horizon_days BETWEEN 1 AND 60),
    ADD COLUMN create_calendar_event BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN add_google_meet BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE booking_slots
    ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'calendar')),
    -- 締め切った理由。calendar = カレンダーに予定が入ったため（予定がなくなれば自動で再開）
    ADD COLUMN closed_by TEXT CHECK (closed_by IN ('manual', 'calendar')),
    ADD COLUMN duration_minutes INT,
    ADD COLUMN google_event_id TEXT,
    ADD COLUMN meeting_url TEXT;

-- リマインダーの {会議URL} に入れる
ALTER TABLE friend_reminders ADD COLUMN meeting_url TEXT;

COMMENT ON TABLE google_calendar_connections IS 'Googleカレンダー連携（チャンネルごと）';
