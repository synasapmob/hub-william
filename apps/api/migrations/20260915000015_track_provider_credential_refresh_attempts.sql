ALTER TABLE agent_connection_credentials
    ADD COLUMN refresh_attempted_at TIMESTAMPTZ;
