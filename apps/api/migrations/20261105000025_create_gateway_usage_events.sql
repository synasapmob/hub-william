-- One row per generation request that reached a provider through the gateway,
-- whoever sent it: a Hub key, or the Playground with a browser session.
-- `outcome` is `completed` when the provider finished the response and
-- `incomplete` when the client left, the stream failed or no completion
-- marker arrived; token counts of an incomplete request are whatever was seen
-- before it stopped, and may be null.
-- `quota` keeps the provider's own rate-limit signals exactly as received
-- (response headers whose names start with `x-codex-`, `anthropic-ratelimit-`,
-- `x-ratelimit-` or `ratelimit-`, and any stream event whose type mentions a
-- rate limit), so the real quota windows can be read back without guessing.
CREATE TABLE gateway_usage_events (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gateway_key_id UUID REFERENCES gateway_keys(id) ON DELETE SET NULL,
    org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    connection_id UUID REFERENCES agent_connections(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT,
    input_tokens BIGINT CHECK (input_tokens >= 0),
    output_tokens BIGINT CHECK (output_tokens >= 0),
    cached_tokens BIGINT CHECK (cached_tokens >= 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'incomplete')),
    quota JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX gateway_usage_events_user_created_idx
    ON gateway_usage_events (user_id, created_at DESC);
CREATE INDEX gateway_usage_events_connection_created_idx
    ON gateway_usage_events (connection_id, created_at DESC);
CREATE INDEX gateway_usage_events_key_created_idx
    ON gateway_usage_events (gateway_key_id, created_at DESC)
    WHERE gateway_key_id IS NOT NULL;
