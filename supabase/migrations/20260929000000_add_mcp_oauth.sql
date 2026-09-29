-- =============================================================================
-- AIエージェント連携（MCP）用の OAuth 2.1 認可サーバー
--
-- Claude（claude.ai / デスクトップ / モバイル / Claude Code）から
-- /api/mcp に接続するとき、利用者本人がこのツールにログインして「許可」した
-- 場合だけアクセストークンを発行する。トークンで操作できるのは、その利用者が
-- channel_members に登録されているチャンネルだけ。
--
-- - mcp_oauth_clients: 動的クライアント登録（RFC 7591）で登録された接続元
-- - mcp_oauth_codes:   認可コード（10分・1回限り。PKCE必須）
-- - mcp_oauth_tokens:  アクセストークン / リフレッシュトークン
--
-- トークン・コード・シークレットは SHA-256 のハッシュだけを保存する。
-- どのテーブルもサーバー（サービスロール）からしか触らないため、RLS を有効にして
-- ポリシーは作らない（= ブラウザの anon / ログインユーザーからは読めない）。
-- =============================================================================

CREATE TABLE mcp_oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT,                                   -- 公開クライアント（token_endpoint_auth_method = none）は NULL
    client_name TEXT,
    redirect_uris TEXT[] NOT NULL,
    token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
        CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE mcp_oauth_clients ENABLE ROW LEVEL SECURITY;

CREATE TABLE mcp_oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT,
    resource TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE mcp_oauth_codes ENABLE ROW LEVEL SECURITY;

CREATE TABLE mcp_oauth_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    access_token_hash TEXT NOT NULL UNIQUE,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    scope TEXT,
    access_expires_at TIMESTAMPTZ NOT NULL,
    refresh_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE mcp_oauth_tokens ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_mcp_oauth_tokens_user_id ON mcp_oauth_tokens(user_id);

COMMENT ON TABLE mcp_oauth_clients IS 'AIエージェント連携（MCP）の接続元クライアント';
COMMENT ON TABLE mcp_oauth_codes IS 'AIエージェント連携（MCP）の認可コード';
COMMENT ON TABLE mcp_oauth_tokens IS 'AIエージェント連携（MCP）のアクセストークン';
