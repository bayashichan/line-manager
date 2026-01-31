-- Add lmessage_webhook_url to channels table
ALTER TABLE public.channels ADD COLUMN IF NOT EXISTS lmessage_webhook_url text;

-- Add description for the column
COMMENT ON COLUMN public.channels.lmessage_webhook_url IS 'External webhook URL to forward LINE events to (e.g. LMessage)';
