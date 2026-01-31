
const { Client } = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Manually parse .env.local because standard dotenv might not handle all cases or path issue
const envPath = path.resolve(__dirname, '.env.local');
if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split(/\r?\n/).forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
            const key = match[1].trim();
            let value = match[2].trim();
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1);
            }
            process.env[key] = value;
        }
    });
} else {
    console.error(".env.local not found at", envPath);
    process.exit(1);
}

// Config LINE
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken) {
    console.error("Access Token missing in env");
    process.exit(1);
}

const client = new Client(config);
console.log("LINE Client initialized.");

// Config Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function testFetch() {
    // 1. Get a user WITHOUT picture_url
    // Since we imported many, there should be one.
    const { data: users, error } = await supabase
        .from('line_users')
        .select('line_user_id, display_name')
        .is('picture_url', null)
        .limit(1);

    if (error) {
        console.error("Supabase Error:", error);
        return;
    }

    let targetId = null;

    if (!users || users.length === 0) {
        console.log("No users without picture_url found. Trying ANY user.");
        const { data: anyUser } = await supabase.from('line_users').select('line_user_id').limit(1);
        if (anyUser && anyUser.length > 0) targetId = anyUser[0].line_user_id;
    } else {
        targetId = users[0].line_user_id;
        console.log(`Found target: ${users[0].display_name}`);
    }

    if (!targetId) {
        console.log("No users found in DB.");
        return;
    }

    console.log(`Testing getProfile for: ${targetId}`);
    try {
        const profile = await client.getProfile(targetId);
        console.log("--- SUCCESS! LINE API Result ---");
        console.log("Display Name:", profile.displayName);
        console.log("Picture URL:", profile.pictureUrl);
        // console.log("Status Message:", profile.statusMessage);
    } catch (e) {
        console.error("--- FAILED LINE API ---");
        // console.error(e);
        if (e.originalError && e.originalError.response) {
            console.error("Status:", e.originalError.response.status);
            console.error("Data:", e.originalError.response.data);
        } else {
            console.error(e.message);
        }
    }
}

testFetch();
