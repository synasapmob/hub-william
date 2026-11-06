-- Pay as you go. The wallet is the only balance and a request spends from it,
-- so the credit, the exchange into it and the withdrawal from it are gone.
--
-- Unspent credit goes back to the wallet first, with a ledger row of its own, so
-- no money disappears with the columns. Rows of kind `exchange` and `withdraw`
-- stay valid: they are history.
INSERT INTO service_ledger
    (id, user_id, kind, amount_micro, wallet_after_micro, credit_after_micro)
SELECT gen_random_uuid(), user_id, 'withdraw', credit_micro, wallet_micro + credit_micro, 0
FROM service_wallets
WHERE credit_micro > 0;

UPDATE service_wallets
SET wallet_micro = wallet_micro + credit_micro, updated_at = NOW()
WHERE credit_micro > 0;

ALTER TABLE service_wallets
    DROP COLUMN credit_capacity_micro,
    DROP COLUMN credit_micro;

ALTER TABLE service_ledger
    DROP COLUMN credit_after_micro;

-- A request that is charged leaves a `usage` row that points at the usage event
-- it was charged for. An event is charged once: a second charge for the same
-- event finds the row and changes nothing.
ALTER TABLE service_ledger
    DROP CONSTRAINT service_ledger_kind_check;
ALTER TABLE service_ledger
    ADD CONSTRAINT service_ledger_kind_check
    CHECK (kind IN ('top_up', 'usage', 'exchange', 'withdraw'));
ALTER TABLE service_ledger
    ADD COLUMN usage_event_id UUID REFERENCES gateway_usage_events(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX service_ledger_usage_event_idx
    ON service_ledger (usage_event_id)
    WHERE usage_event_id IS NOT NULL;

-- The price of one model, when it is not the price of its agent. A model with
-- no row costs what its agent costs (`service_prices`), and an agent with no row
-- costs what `default` says. The effort variants of a model share one row.
CREATE TABLE service_model_prices (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_micro_per_million BIGINT NOT NULL CHECK (input_micro_per_million >= 0),
    cached_micro_per_million BIGINT NOT NULL CHECK (cached_micro_per_million >= 0),
    output_micro_per_million BIGINT NOT NULL CHECK (output_micro_per_million >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, model)
);

-- A key belongs to one product, and each product has its own keys:
--   workspace     made on the Agents page; served by the owner's own accounts and
--                 pools, free;
--   organization  made on an organization's Agents page; served only by the agents
--                 that organization shares, counted in that organization's usage,
--                 free;
--   service       made on the Service's Keys page; served only by the platform's
--                 stock of accounts, charged to the owner's service wallet.
-- Neither kind can do what another does. Only an organization key names an
-- organization.
ALTER TABLE gateway_keys
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace'
        CHECK (kind IN ('workspace', 'organization', 'service')),
    ADD CONSTRAINT gateway_keys_kind_organization_check
        CHECK ((kind = 'organization') = (organization_id IS NOT NULL));

-- Which product a request belonged to, so each product reads only its own usage:
-- by what sent it, not by a key that may be gone. The Playground has no key, so
-- its chats count in the scope the user chose.
ALTER TABLE gateway_usage_events
    ADD COLUMN scope TEXT NOT NULL DEFAULT 'workspace'
        CHECK (scope IN ('workspace', 'organization', 'service'));
UPDATE gateway_usage_events SET scope = 'organization' WHERE org_id IS NOT NULL;
CREATE INDEX gateway_usage_events_user_scope_idx
    ON gateway_usage_events (user_id, scope, created_at DESC);

-- An account that belongs to the platform's stock: the only accounts a service
-- key is served by. Marked in the database until a page manages the stock.
ALTER TABLE agent_connections
    ADD COLUMN service_stock BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX agent_connections_service_stock_idx
    ON agent_connections (provider, availability_status)
    WHERE service_stock AND status = 'connected';
