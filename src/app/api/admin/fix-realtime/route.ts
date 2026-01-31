import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { Client } from 'pg'

export async function POST(req: NextRequest) {
    try {
        // 1. 管理者認証チェック
        const supabase = await createClient()
        const { data: { user }, error } = await supabase.auth.getUser()

        if (error || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // 2. DB接続設定
        // Next.jsの環境変数からDB接続情報を取得
        // SupabaseのTransaction pooler推奨 (port 6543) だが、DDL実行にはSession pooler (port 5432) が必要な場合がある
        // ここではDATABASE_URLを使用する想定
        // Next.jsの環境変数からDB接続情報を取得
        // DDL実行にはSession pooler (port 5432) が必要 (port 6543のみだとCREATE PUBLICATIONなどで失敗する)
        let connectionString = process.env.DIRECT_URL ||
            process.env.DATABASE_URL ||
            process.env.POSTGRES_URL ||
            process.env.POSTGRES_PRISMA_URL ||
            process.env.POSTGRES_URL_NON_POOLING ||
            process.env.SUPABASE_DB_URL

        if (!connectionString) {
            console.error('Environment Variables:', {
                DIRECT_URL: !!process.env.DIRECT_URL,
                DATABASE_URL: !!process.env.DATABASE_URL,
                POSTGRES_URL: !!process.env.POSTGRES_URL,
                POSTGRES_PRISMA_URL: !!process.env.POSTGRES_PRISMA_URL,
                POSTGRES_URL_NON_POOLING: !!process.env.POSTGRES_URL_NON_POOLING,
                SUPABASE_DB_URL: !!process.env.SUPABASE_DB_URL
            })
            return NextResponse.json({ error: 'Database connection string not found. Please set DATABASE_URL or DIRECT_URL in Vercel Environment Variables.' }, { status: 500 })
        }

        // Connection Pooler (6543) を使っている場合、Session Pooler (5432) に置換
        if (connectionString.includes(':6543')) {
            connectionString = connectionString.replace(':6543', ':5432')
        }

        const client = new Client({
            connectionString: connectionString,
            ssl: { rejectUnauthorized: false } // Supabase接続用
        })

        await client.connect()

        try {
            // 3. SQL実行
            // RLS有効化
            await client.query('ALTER TABLE line_users ENABLE ROW LEVEL SECURITY;')

            // ポリシー再作成
            await client.query('DROP POLICY IF EXISTS "メンバーはユーザーを参照可能" ON line_users;')
            await client.query(`
                CREATE POLICY "メンバーはユーザーを参照可能" ON line_users
                FOR SELECT USING (
                    EXISTS (
                        SELECT 1 FROM channel_members
                        WHERE channel_members.channel_id = line_users.channel_id
                        AND channel_members.profile_id = auth.uid()
                    )
                );
            `)

            await client.query('DROP POLICY IF EXISTS "メンバーはユーザーを更新可能" ON line_users;')
            await client.query(`
                CREATE POLICY "メンバーはユーザーを更新可能" ON line_users
                FOR UPDATE USING (
                    EXISTS (
                        SELECT 1 FROM channel_members
                        WHERE channel_members.channel_id = line_users.channel_id
                        AND channel_members.profile_id = auth.uid()
                    )
                );
            `)

            // リアルタイム設定 (Publication)
            // pg_publicationなどをチェックして追加
            await client.query(`
                DO $$
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
                        CREATE PUBLICATION supabase_realtime;
                    END IF;
                    
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_publication_tables 
                        WHERE pubname = 'supabase_realtime' 
                        AND schemaname = 'public' 
                        AND tablename = 'line_users'
                    ) THEN
                        ALTER PUBLICATION supabase_realtime ADD TABLE line_users;
                    END IF;
                END;
                $$;
            `)

            // 4. スキーマ更新 (last_message_content追加)
            await client.query('ALTER TABLE line_users ADD COLUMN IF NOT EXISTS last_message_content TEXT;')

            return NextResponse.json({ success: true, message: 'Database configuration fixed successfully' })

        } catch (sqlError: any) {
            console.error('SQL Execution Error:', sqlError)
            return NextResponse.json({ error: `SQL Execution Failed: ${sqlError.message}` }, { status: 500 })
        } finally {
            await client.end()
        }

    } catch (error: any) {
        console.error('API Error:', error)
        return NextResponse.json({ error: `Internal Server Error: ${error.message}` }, { status: 500 })
    }
}
