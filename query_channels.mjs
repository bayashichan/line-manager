import pg from 'pg';
const { Client } = pg;

const client = new Client({
    connectionString: process.env.DATABASE_URL
});

async function main() {
    await client.connect();
    console.log("Connected to DB!");
    try {
        const res = await client.query("SELECT * FROM channels LIMIT 10");
        console.log("Found channels:", res.rows);
    } catch (err) {
        console.error("Query error:", err);
    } finally {
        await client.end();
    }
}

main();
