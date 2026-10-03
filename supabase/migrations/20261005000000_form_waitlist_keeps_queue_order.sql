-- =============================================================================
-- 申込フォームのキャンセル待ちの順番を守る
--
-- これまでは「申込（キャンセル待ちを除く）の数 < 定員」なら新しい申込を席に入れて
-- いた。そのため満席でキャンセル待ちの人がいても、
--   - キャンセルの回答を削除した
--   - 申込を「キャンセル待ちに戻す」にした
--   - 定員を増やした
-- などで席が空くと、繰り上げる前に申し込んだ新しい人がその席を取ってしまい、
-- 先に待っていた人を追い越して「申込」になっていた。
--
-- 空いた席はキャンセル待ちの人の繰り上げ用に取っておき、新しい申込に出すのは
-- 「定員 - 申込 - キャンセル待ち」の席だけにする。足りなければ新しい人は
-- キャンセル待ち（締切設定なら満席で受付終了）になる。
--
-- アプリ側の残席表示（src/lib/forms/capacity.ts の computeAvailability）も
-- 同じ数え方にしている。
-- =============================================================================

CREATE OR REPLACE FUNCTION assign_form_response_entry_status()
RETURNS TRIGGER AS $$
DECLARE
    f RECORD;
    confirmed_count INTEGER;
    waitlisted_count INTEGER;
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

    SELECT
        COUNT(*) FILTER (WHERE entry_status = 'confirmed'),
        COUNT(*) FILTER (WHERE entry_status = 'waitlisted')
    INTO confirmed_count, waitlisted_count
    FROM form_responses
    WHERE form_id = NEW.form_id;

    -- キャンセル待ちの人がいれば、空いた席はその人たちの繰り上げ用
    IF confirmed_count + waitlisted_count < f.capacity THEN
        NEW.entry_status := 'confirmed';
    ELSIF f.full_action = 'waitlist' THEN
        NEW.entry_status := 'waitlisted';
    ELSE
        RAISE EXCEPTION 'FORM_FULL' USING HINT = '定員に達したため申込を締め切りました';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
