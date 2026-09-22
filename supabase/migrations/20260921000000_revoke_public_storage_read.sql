-- Supabase Storage の公開読み取りを閉じる（転送量超過の再発防止）
--
-- 背景:
--   LINEは配信のたびに画像・動画URLを受信者ぶん取得する。公開バケットを配信元にすると
--   転送量(cached egress)が無料枠を超え、プロジェクトごと停止される。
--   配信元は Cloudflare R2（egress無料）へ移したので、Supabase側は公開しない。
--
-- 適用タイミング:
--   必ず POST /api/admin/migrate-storage で既存アセットをR2へ移し（copy → rewrite）、
--   ダッシュボードで画像が表示されることを確認したあとに実行すること。
--   先に実行すると、DBに残っている旧URLの画像が表示されなくなる。

-- 1. バケットを非公開にする（CDN経由の配信を止める）
UPDATE storage.buckets
SET public = false
WHERE id IN ('chat-uploads', 'line-assets');

-- 2. 公開読み取りポリシーを削除する
DROP POLICY IF EXISTS "Allow public read" ON storage.objects;

-- 3. 認証済みユーザーの読み取りだけ残す（移行漏れの調査用）
DROP POLICY IF EXISTS "Allow authenticated read" ON storage.objects;
CREATE POLICY "Allow authenticated read"
ON storage.objects FOR SELECT
TO authenticated
USING ( bucket_id IN ('chat-uploads', 'line-assets') );
