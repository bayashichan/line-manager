const { Client } = require('pg');

const client = new Client({
    connectionString: 'postgresql://postgres.ulxmtbcmzykbinwnxvvu:ZX6O2inRYlf6cmqN@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres',
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        console.log('Connected to database.');

        // 既存のポリシーを削除（もしあれば）
        try {
            await client.query(`DROP POLICY IF EXISTS "ユーザーは自分のプロフィールを参照可能" ON profiles;`);
            await client.query(`DROP POLICY IF EXISTS "Authenticated users can view all profiles" ON profiles;`);
        } catch (e) {
            console.log('Policy drop skipped or failed (non-fatal):', e.message);
        }

        // 新しいポリシーを作成: 認証済みユーザーは全プロフィールの主要項目を見れるようにする
        // (チーム機能のために必要。emailを知っていれば招待できるモデルなので、基本プロフィール公開は許容範囲とする)
        // 本当はチームメンバーのみに絞るのがベストだが、招待前の検索などで結局必要になることが多い。
        await client.query(`
      CREATE POLICY "Authenticated users can view all profiles" ON profiles
      FOR SELECT
      USING (auth.role() = 'authenticated');
    `);

        console.log('Successfully updated profiles RLS policy.');

    } catch (err) {
        console.error('Error executing query:', err);
    } finally {
        await client.end();
    }
}

run();
