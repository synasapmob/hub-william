ALTER TABLE agent_connection_credentials
    ADD COLUMN next_refresh_at TIMESTAMPTZ,
    ADD COLUMN refresh_failure_count INTEGER NOT NULL DEFAULT 0
        CONSTRAINT agent_connection_credentials_refresh_failure_count_check
            CHECK (refresh_failure_count >= 0);

-- Keep each account on the schedule the previous sweep derived (30 minutes plus
-- a per-account offset of up to 15 minutes), so deploying does not make every
-- account due in the same minute. After its next refresh each account is
-- scheduled exactly 30 minutes ahead.
UPDATE agent_connection_credentials
SET next_refresh_at = GREATEST(updated_at, COALESCE(refresh_attempted_at, updated_at))
    + INTERVAL '30 minutes'
    + make_interval(secs => get_byte(uuid_send(connection_id), 15) * 900 / 256);

ALTER TABLE agent_connection_credentials
    ALTER COLUMN next_refresh_at SET NOT NULL,
    ALTER COLUMN next_refresh_at SET DEFAULT (NOW() + INTERVAL '30 minutes');

CREATE INDEX agent_connection_credentials_next_refresh_idx
    ON agent_connection_credentials (next_refresh_at);
