import pg from 'pg';
const { Client } = pg;

const client = new Client({
    connectionString: 'postgresql://postgres.ulxmtbcmzykbinwnxvvu:ZX6O2inRYlf6cmqN@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres'
});

async function main() {
    await client.connect();
    console.log("Connected to DB!");
    try {
        const res = await client.query("SELECT * FROM line_users WHERE line_user_id = 'U91879d392b6d8aeecbd6e8f23f376e24'");
        console.log("Found line_users:", res.rows);
    } catch (err) {
        console.error("Query error:", err);
    } finally {
        await client.end();
    }
}

main();
