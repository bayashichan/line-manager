-- ad_conversions テーブルにクライアントIPアドレスを保存するカラムを追加
-- Meta CAPI の client_ip_address フィールドに使用し、マッチングクオリティを向上させる
ALTER TABLE ad_conversions
ADD COLUMN IF NOT EXISTS client_ip TEXT;
