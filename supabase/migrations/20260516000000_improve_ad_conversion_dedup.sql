-- LIFFコンバージョン計測の信頼性向上のためのスキーマ変更
--
-- 背景:
-- (1) fbc を LP から直接受け取れるように保存先を追加（最も正確な EMQ）
-- (2) fbc を構築する click_time を独立カラムで保存（従来は fbp タイムスタンプを流用しており EMQ 低下要因）
-- (3) Meta CAPI 送信時の deterministic な event_id を保存（送信履歴・冪等性確認用）
-- (4) 同一 (channel_id, line_user_id) で pending 行が二重に存在しないよう DB レベルで保証

ALTER TABLE ad_conversions
    ADD COLUMN IF NOT EXISTS fbc TEXT,
    ADD COLUMN IF NOT EXISTS click_time_ms BIGINT,
    ADD COLUMN IF NOT EXISTS meta_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ad_conversions_channel_user_pending_uniq
    ON ad_conversions (channel_id, line_user_id)
    WHERE status = 'pending';
