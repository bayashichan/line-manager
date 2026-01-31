const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Manually parse .env.local
try {
    const envContent = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8');
    envContent.split('\n').forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
            const key = match[1].trim();
            const value = match[2].trim().replace(/^['"]|['"]$/g, ''); // Remove quotes
            if (!process.env[key]) {
                process.env[key] = value;
            }
        }
    });
} catch (e) {
    console.error("Could not read .env.local", e);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

console.log('URL:', supabaseUrl);
console.log('Key used:', supabaseKey ? (supabaseKey.substring(0, 10) + '...') : 'NONE');

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

async function check() {
    console.log('--- Checking Channels Table ---');
    const { data: channels, error } = await supabase.from('channels').select('id, name, channel_id, created_at, channel_secret, channel_access_token');

    if (error) {
        console.error('Error fetching channels:', error);
    } else {
        console.log(`Found ${channels.length} channels:`);
        channels.forEach(ch => {
            console.log(`- ID: ${ch.id}`);
            console.log(`  Name: ${ch.name}`);
            console.log(`  ChannelID (DB): "${ch.channel_id}"`); // Quote to see whitespace
            console.log(`  Secret: ${ch.channel_secret ? ch.channel_secret.substring(0, 5) + '...' : 'NULL'}`);
            console.log(`  Token: ${ch.channel_access_token ? ch.channel_access_token.substring(0, 10) + '...' : 'NULL'}`);
            console.log('-------------------');
        });
    }
}

check();
