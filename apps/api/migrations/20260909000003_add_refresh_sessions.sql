ALTER TABLE sessions
    ADD COLUMN refresh_token_hash CHAR(64) UNIQUE,
    ADD COLUMN refresh_expires_at TIMESTAMPTZ;

UPDATE sessions
SET expires_at = LEAST(expires_at, NOW() + INTERVAL '5 hours');

CREATE INDEX sessions_refresh_expires_at_index ON sessions(refresh_expires_at);
