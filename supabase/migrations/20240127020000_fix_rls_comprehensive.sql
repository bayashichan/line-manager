-- 1. 自分が作成したチャンネルを参照できるようにするポリシー
-- (これがないと、次のポリシーチェックでチャンネルが見つからず失敗します)
CREATE POLICY "作成者は自分のチャンネルを参照可能" ON channels
    FOR SELECT USING (created_by = auth.uid());

-- 2. チャンネル作成者が自分をメンバー（オーナー）として追加できるようにするポリシー
-- (重複エラーが出た場合は無視して構いません)
DROP POLICY IF EXISTS "作成者は自分をメンバーに追加可能" ON channel_members;
CREATE POLICY "作成者は自分をメンバーに追加可能" ON channel_members
    FOR INSERT WITH CHECK (
        auth.uid() = profile_id
        AND EXISTS (
             SELECT 1 FROM channels
             WHERE channels.id = channel_members.channel_id
             AND channels.created_by = auth.uid()
        )
    );
