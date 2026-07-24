-- =============================================================================
-- 申込フォームの回答を管理画面から編集・削除できるようにする
-- 既存は SELECT のみ許可だったため、チャンネルメンバーに管理(UPDATE/DELETE)を許可する。
-- INSERT は引き続きサービスロール(admin client)経由で行われる（RLSバイパス）。
-- =============================================================================
CREATE POLICY "メンバーは回答を管理可能" ON form_responses
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM channel_members
            WHERE channel_members.channel_id = form_responses.channel_id
            AND channel_members.profile_id = auth.uid()
        )
    );
