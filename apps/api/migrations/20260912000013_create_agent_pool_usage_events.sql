CREATE TABLE agent_pool_usage_events (
    id UUID PRIMARY KEY,
    connection_id UUID NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cached_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX agent_pool_usage_events_connection_created_idx
    ON agent_pool_usage_events (connection_id, created_at);
