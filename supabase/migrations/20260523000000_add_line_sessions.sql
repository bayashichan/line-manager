CREATE TABLE line_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id),
  fbclid TEXT,
  fbp TEXT,
  fbc TEXT,
  oa TEXT,
  tag TEXT,
  user_agent TEXT,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  line_user_id TEXT,
  matched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_line_sessions_channel_clicked
  ON line_sessions (channel_id, clicked_at DESC);
