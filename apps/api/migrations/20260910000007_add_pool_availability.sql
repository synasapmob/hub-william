ALTER TABLE agent_connections
    ADD COLUMN availability_status VARCHAR(16) NOT NULL DEFAULT 'active'
        CHECK (availability_status IN ('active', 'rate_limited', 'half_open')),
    ADD COLUMN rate_limited_until TIMESTAMPTZ,
    ADD COLUMN retry_claimed_at TIMESTAMPTZ;

CREATE INDEX agent_connections_availability_idx
    ON agent_connections (provider, availability_status, rate_limited_until)
    WHERE status = 'connected';

UPDATE agent_connections
SET account_label =
    LEFT(SPLIT_PART(account_label, '@', 1), 3)
    || '**@**'
    || SUBSTRING(SPLIT_PART(account_label, '@', 2) FROM '(\.[^.]+)$')
WHERE account_label LIKE '%@%.%';
