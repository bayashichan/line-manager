-- ============================================================
-- チャンネル作成トラブルシューティング用 統合修正SQL
-- ============================================================

-- 1. カラムの存在確認と追加 (安全策)
-- もしカラムがなくてエラーになっている場合はこれで直ります
ALTER TABLE channels ADD COLUMN IF NOT EXISTS access_password TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id);

-- 2. ポリシーの再設定 (完全版)

-- チャンネル作成の許可 (念のため)
DROP POLICY IF EXISTS "認証ユーザーはチャンネルを作成可能" ON channels;
CREATE POLICY "認証ユーザーはチャンネルを作成可能" ON channels
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- 自分のチャンネルを見る許可
DROP POLICY IF EXISTS "作成者は自分のチャンネルを参照可能" ON channels;
CREATE POLICY "作成者は自分のチャンネルを参照可能" ON channels
    FOR SELECT USING (created_by = auth.uid());

-- メンバー追加の許可
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

-- 3. チャンネルテーブルの更新権限 (作成者が更新できるようにする)
DROP POLICY IF EXISTS "作成者は自分のチャンネルを更新可能" ON channels;
CREATE POLICY "作成者は自分のチャンネルを更新可能" ON channels
    FOR UPDATE USING (created_by = auth.uid());
