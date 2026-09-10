ALTER TABLE agent_connections
    DROP CONSTRAINT agent_connections_user_provider_unique;

CREATE INDEX agent_connections_user_provider_idx
    ON agent_connections (user_id, provider);
