ALTER TABLE agent_connections
    DROP CONSTRAINT agent_connections_provider_check;

ALTER TABLE agent_connections
    ADD CONSTRAINT agent_connections_provider_check
    CHECK (provider IN ('chatgpt', 'claude', 'grok', 'gemini', 'deepseek'));
