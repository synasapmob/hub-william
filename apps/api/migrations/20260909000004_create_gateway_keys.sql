CREATE TABLE gateway_keys (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash BYTEA NOT NULL UNIQUE,
    last_four TEXT NOT NULL CHECK (char_length(last_four) = 4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX gateway_keys_user_created_idx
    ON gateway_keys (user_id, created_at DESC);

CREATE INDEX gateway_keys_active_hash_idx
    ON gateway_keys (key_hash)
    WHERE revoked_at IS NULL;
