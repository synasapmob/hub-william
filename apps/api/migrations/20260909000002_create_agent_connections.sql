CREATE TABLE agent_connections (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    account_label TEXT,
    plan TEXT,
    failure_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agent_connections_provider_check
        CHECK (provider IN ('chatgpt', 'claude', 'grok')),
    CONSTRAINT agent_connections_status_check
        CHECK (status IN ('pending', 'connected', 'failed', 'disconnected')),
    CONSTRAINT agent_connections_user_provider_unique UNIQUE (user_id, provider)
);

CREATE INDEX agent_connections_user_id_index ON agent_connections(user_id);

CREATE TABLE agent_connection_authorizations (
    connection_id UUID PRIMARY KEY REFERENCES agent_connections(id) ON DELETE CASCADE,
    flow TEXT NOT NULL,
    secret_ciphertext BYTEA NOT NULL,
    secret_nonce BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agent_connection_authorizations_flow_check
        CHECK (flow IN ('device_code', 'authorization_code'))
);

CREATE INDEX agent_connection_authorizations_expires_at_index
    ON agent_connection_authorizations(expires_at);

CREATE TABLE agent_connection_credentials (
    connection_id UUID PRIMARY KEY REFERENCES agent_connections(id) ON DELETE CASCADE,
    credential_ciphertext BYTEA NOT NULL,
    credential_nonce BYTEA NOT NULL,
    access_token_expires_at TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
