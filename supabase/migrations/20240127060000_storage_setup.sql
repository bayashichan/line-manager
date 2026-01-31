-- Storage Bucket Setup for Chat Uploads

-- 1. Create Bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-uploads', 'chat-uploads', true)
ON CONFLICT (id) DO NOTHING;

-- 2. Enable RLS
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 3. Policies
-- Allow uploads by authenticated users (channel members)
CREATE POLICY "Allow authenticated uploads"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK ( bucket_id = 'chat-uploads' );

-- Allow reading by everyone (since we need to send public URLs to LINE)
-- Or restrict to authenticated users if we use signed URLs, but LINE needs public access for images usually unless we proxy.
-- For simplicity and LINE compatibility, we make the bucket public (as defined above) and allow public read.
CREATE POLICY "Allow public read"
ON storage.objects FOR SELECT
TO public
USING ( bucket_id = 'chat-uploads' );
