-- =============================================================================
-- form_responses: 申込完了時の自動返信の送信結果
--
-- これまで自動返信(push)の成否はサーバーログにしか出ておらず、失敗しても
-- 管理画面からは分からなかった。回答ごとに結果を残し、申込者一覧・回答一覧で
-- 確認できるようにする。
--
-- 回答の保存を先に行い、そのあと送信結果で更新する。送信処理の途中で止まった
-- 回答が 'pending' のまま残るよう、新しい行の既定値を 'pending' にする。
-- 既存の行は送信結果が分からないので NULL（記録なし）のままにする。
-- =============================================================================

ALTER TABLE form_responses
    ADD COLUMN IF NOT EXISTS completion_reply_status TEXT
        CHECK (completion_reply_status IN ('pending', 'sent', 'failed', 'skipped')),
    ADD COLUMN IF NOT EXISTS completion_reply_error TEXT,
    ADD COLUMN IF NOT EXISTS completion_reply_at TIMESTAMPTZ;

-- ADD COLUMN と同時に DEFAULT を付けると既存行まで 'pending' になるため、分けて設定する
ALTER TABLE form_responses ALTER COLUMN completion_reply_status SET DEFAULT 'pending';

COMMENT ON COLUMN form_responses.completion_reply_status IS '完了時の自動返信: pending=送信処理中（止まったまま残れば結果不明）/ sent=LINEが受付 / failed=送信失敗 / skipped=送らなかった / NULL=記録なし（機能追加前の回答）';
COMMENT ON COLUMN form_responses.completion_reply_error IS '送信失敗・未送信の理由（LINE APIのエラー本文など）';
COMMENT ON COLUMN form_responses.completion_reply_at IS '送信結果を記録した日時';
