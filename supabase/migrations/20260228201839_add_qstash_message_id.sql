-- Add qstash_message_id column and update status constraint
ALTER TABLE messages ADD COLUMN qstash_message_id TEXT;

-- Since SQLite doesn't easily alter constraints, let's just drop and recreate if needed? Wait, Supabase is PostgreSQL!
-- Drop the existing constraint
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;

-- Add the new constraint with 'cancelled'
ALTER TABLE messages ADD CONSTRAINT messages_status_check 
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'));

