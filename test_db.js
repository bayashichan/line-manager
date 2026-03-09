import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
async function test() {
  const { data, error } = await supabase.from('line_users').select('display_name').ilike('display_name', '%???%').limit(5)
  console.log("DB response ??? :", data, error)
  const { data: data2 } = await supabase.from('line_users').select('display_name').ilike('display_name', '%Mee%').limit(5)
  console.log("DB response Mee :", data2)
}
test()
