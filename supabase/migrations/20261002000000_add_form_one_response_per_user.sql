-- =============================================================================
-- 申込フォームの重複申込の防止と、申込者本人による内容の修正
--
-- 同じ人（LINEのuserId）が同じフォームに2回目以降の申込をしたときは、新しい回答を
-- 増やさず、「申込内容を修正しますか？」と聞いてから既存の回答を書き換える。
--
-- フォームごとにオン/オフでき、既存のフォームも含めて既定はオン（1人1回まで）。
-- 問い合わせ・アンケートなど何度でも送ってよいフォームはオフにする。
--
-- 既にある重複した回答（この機能の追加前に送られたもの）は消さずに残す。
-- 修正するときは、その人の最新の回答を書き換える。
-- =============================================================================

ALTER TABLE forms
    ADD COLUMN IF NOT EXISTS one_response_per_user BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN forms.one_response_per_user IS '1人1回まで受け付けるか。TRUE なら同じ人の2回目以降は新しい申込にせず、申込内容の修正として受け付ける';

-- 管理画面での編集や自動返信の結果の記録では更新しない（本人が修正したときだけ入れる）
ALTER TABLE form_responses
    ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

COMMENT ON COLUMN form_responses.edited_at IS '申込者本人が申込内容を最後に修正した日時。NULL = 修正なし';

-- 本人の回答を探すため（フォームを開いたとき・申込のたびに引く）
CREATE INDEX IF NOT EXISTS idx_form_responses_form_user
    ON form_responses(form_id, line_user_id_raw);

-- -----------------------------------------------------------------------------
-- 申込時のチェックに重複申込の拒否を加える
--
-- アプリ側でも保存前に既存の回答を探すが、送信ボタンの連打や2つの画面から同時に
-- 送ったときは、どちらも「まだ無い」と判断してしまう。フォームの行をロックして
-- 同じフォームへの申込を1件ずつ処理しているこのトリガーで確かめる。
--
-- 同じ人の回答が既にあれば 'DUPLICATE_RESPONSE' で保存を拒否する（アプリ側でこの
-- メッセージを見て「申込済み。修正しますか？」と応答する）。満席の判定より先に
-- 行うので、申込済みの人には満席ではなく修正の案内が出る。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assign_form_response_entry_status()
RETURNS TRIGGER AS $$
DECLARE
    f RECORD;
    confirmed_count INTEGER;
BEGIN
    SELECT capacity_enabled, capacity, full_action, one_response_per_user
    INTO f
    FROM forms
    WHERE id = NEW.form_id
    FOR UPDATE;

    IF NOT FOUND THEN
        NEW.entry_status := 'confirmed';
        RETURN NEW;
    END IF;

    IF f.one_response_per_user
        AND NEW.line_user_id_raw IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM form_responses
            WHERE form_id = NEW.form_id
            AND line_user_id_raw = NEW.line_user_id_raw
        )
    THEN
        RAISE EXCEPTION 'DUPLICATE_RESPONSE' USING HINT = 'このフォームには既に申し込まれています';
    END IF;

    IF NOT f.capacity_enabled OR f.capacity IS NULL THEN
        NEW.entry_status := 'confirmed';
        RETURN NEW;
    END IF;

    SELECT COUNT(*)
    INTO confirmed_count
    FROM form_responses
    WHERE form_id = NEW.form_id
    AND entry_status = 'confirmed';

    IF confirmed_count < f.capacity THEN
        NEW.entry_status := 'confirmed';
    ELSIF f.full_action = 'waitlist' THEN
        NEW.entry_status := 'waitlisted';
    ELSE
        RAISE EXCEPTION 'FORM_FULL' USING HINT = '定員に達したため申込を締め切りました';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
