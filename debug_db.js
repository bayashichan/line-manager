require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function debug() {
    const { data, error } = await supabase.from('messages').select('id, status, error_message, sent_at, scheduled_at').order('created_at', { ascending: false }).limit(5);
    console.log("Recent messages:", data);
}
debug();
