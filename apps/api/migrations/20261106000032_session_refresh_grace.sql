-- Rotating the refresh token on every refresh logs a person out when two requests
-- refresh together (two tabs, or the storefront and the dashboard, waking at once):
-- the first replaces the token and the second arrives with the one it replaced. The
-- token that was just replaced is kept for a short while, so the second is still
-- known and gets a new access session instead of a 401.
ALTER TABLE sessions
    ADD COLUMN previous_refresh_token_hash CHAR(64),
    ADD COLUMN previous_refresh_valid_until TIMESTAMPTZ;

CREATE INDEX sessions_previous_refresh_token_hash_index
    ON sessions(previous_refresh_token_hash)
    WHERE previous_refresh_token_hash IS NOT NULL;
