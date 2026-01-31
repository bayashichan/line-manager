-- チャンネル作成者が自分をメンバー（オーナー）として追加できるようにするポリシー
CREATE POLICY "作成者は自分をメンバーに追加可能" ON channel_members
    FOR INSERT WITH CHECK (
        auth.uid() = profile_id
        AND EXISTS (
             SELECT 1 FROM channels
             WHERE channels.id = channel_members.channel_id
             AND channels.created_by = auth.uid()
        )
    );
