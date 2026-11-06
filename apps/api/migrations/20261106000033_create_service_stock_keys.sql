-- The keys the Service sells from. A member of staff adds one of their own Hub
-- keys for an agent, and the Service serves its customers' requests for that
-- agent with the accounts the key reaches: a workspace key reaches its owner's own
-- accounts, an organization key the accounts its members share with that
-- organization. Not a pool the owner has joined, and nothing of anyone who is not on
-- the staff (the reach is worked out in `api::service::stock`).
--
-- Revoking the key, or deleting it, takes it out of the stock.
CREATE TABLE service_stock_keys (
    id UUID PRIMARY KEY,
    provider TEXT NOT NULL CHECK (
        provider IN ('chatgpt', 'gemini', 'claude', 'deepseek', 'grok', 'groq')
    ),
    gateway_key_id UUID NOT NULL REFERENCES gateway_keys(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, gateway_key_id)
);

CREATE INDEX service_stock_keys_provider_idx ON service_stock_keys (provider);
