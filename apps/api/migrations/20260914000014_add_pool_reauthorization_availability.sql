ALTER TABLE agent_connections
    DROP CONSTRAINT agent_connections_availability_status_check;

ALTER TABLE agent_connections
    ADD CONSTRAINT agent_connections_availability_status_check
        CHECK (availability_status IN ('active', 'rate_limited', 'half_open', 'reauth_required'));
