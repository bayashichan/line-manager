-- ============================================================
-- 無限再帰 (infinite recursion) エラー修正SQL
-- ============================================================

-- 1. 再帰エラー回避用の関数定義
-- SECURITY DEFINERを指定することで、RLSをバイパスしてチェックを行います
CREATE OR REPLACE FUNCTION public.check_channel_owner(c_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 
    FROM public.channel_members 
    WHERE channel_id = c_id 
    AND profile_id = auth.uid() 
    AND role = 'owner'
  );
END;
$$;

-- 2. 問題のポリシー（再帰してしまうもの）を削除
DROP POLICY IF EXISTS "オーナーはメンバーを管理可能" ON channel_members;

-- 3. 関数を使った新しいポリシー（再帰しない）を作成
CREATE POLICY "オーナーはメンバーを管理可能" ON channel_members
    FOR ALL
    USING ( check_channel_owner(channel_id) );

-- 4. 念のため、チャンネル作成者自身を追加するポリシーも再適用
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
