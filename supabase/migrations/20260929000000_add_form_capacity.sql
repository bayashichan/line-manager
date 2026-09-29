-- =============================================================================
-- 申込フォームの残席設定（定員）
--
-- フォームごとに定員を設定でき、オン/オフを切り替えられる。申込（キャンセル待ち
-- を除く）が定員に達したら、フォームの設定に応じて
--   - waitlist: キャンセル待ちとして受け付ける
--   - close:    申込を締め切る
-- のどちらかに自動で切り替える。
--
-- 残席は「entry_status = 'confirmed' の回答数」から都度数える。回答を削除すれば
-- 席が空き、キャンセル待ちを繰り上げれば席が埋まる。
-- =============================================================================

ALTER TABLE forms
    ADD COLUMN IF NOT EXISTS capacity_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
    ADD COLUMN IF NOT EXISTS full_action TEXT NOT NULL DEFAULT 'waitlist'
        CHECK (full_action IN ('waitlist', 'close')),
    ADD COLUMN IF NOT EXISTS waitlist_message TEXT,
    ADD COLUMN IF NOT EXISTS waitlist_tag_ids UUID[];

ALTER TABLE forms DROP CONSTRAINT IF EXISTS forms_capacity_required;
ALTER TABLE forms
    ADD CONSTRAINT forms_capacity_required
        CHECK (NOT capacity_enabled OR capacity IS NOT NULL);

COMMENT ON COLUMN forms.capacity_enabled IS '残席設定を使うか。FALSE なら定員なしで受け付ける';
COMMENT ON COLUMN forms.capacity IS '定員（席数）';
COMMENT ON COLUMN forms.full_action IS '満席時の動作: waitlist=キャンセル待ちとして受け付ける / close=申込を締め切る';
COMMENT ON COLUMN forms.waitlist_message IS 'キャンセル待ちで受け付けたときの自動返信（テキスト。{name}差し込み可）。NULLなら既定の文面';
COMMENT ON COLUMN forms.waitlist_tag_ids IS 'キャンセル待ちで受け付けたときに付与するタグID（完了タグの代わりに付ける）';

-- 既存の回答はすべて通常の申込として扱う
ALTER TABLE form_responses
    ADD COLUMN IF NOT EXISTS entry_status TEXT NOT NULL DEFAULT 'confirmed'
        CHECK (entry_status IN ('confirmed', 'waitlisted'));

COMMENT ON COLUMN form_responses.entry_status IS '申込状態: confirmed=申込（席を確保） / waitlisted=キャンセル待ち';

CREATE INDEX IF NOT EXISTS idx_form_responses_form_entry_status
    ON form_responses(form_id, entry_status);

-- -----------------------------------------------------------------------------
-- 申込時に定員から申込状態を決める
--
-- アプリ側で「数えてから保存」すると、残り1席に2人が同時に申し込んだとき両方が
-- 席を取れてしまう。フォームの行をロックして同じフォームへの申込を1件ずつ処理し、
-- 数える・決める・保存するを1つのトランザクションで行う。
--
-- 締切（close）で満席のときは 'FORM_FULL' で保存を拒否する（アプリ側でこの
-- メッセージを見て「満席」と応答する）。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assign_form_response_entry_status()
RETURNS TRIGGER AS $$
DECLARE
    f RECORD;
    confirmed_count INTEGER;
BEGIN
    SELECT capacity_enabled, capacity, full_action
    INTO f
    FROM forms
    WHERE id = NEW.form_id
    FOR UPDATE;

    IF NOT FOUND OR NOT f.capacity_enabled OR f.capacity IS NULL THEN
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

DROP TRIGGER IF EXISTS assign_form_response_entry_status ON form_responses;
CREATE TRIGGER assign_form_response_entry_status
    BEFORE INSERT ON form_responses
    FOR EACH ROW EXECUTE FUNCTION assign_form_response_entry_status();
