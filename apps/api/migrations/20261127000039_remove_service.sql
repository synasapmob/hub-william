-- The SERVICE product is gone: no wallet, no top-up by card, no price list, no
-- tickets, and no service or ticket keys. The migrations that built it
-- (20261105000026 to 20261106000034) have already run, so this one takes it out.
--
-- This deletes data and cannot be undone. Wallet balances, the ledger, top-ups,
-- the price list, tickets on sale and sold, the keys of customers who bought
-- them, and the usage of service and ticket keys are all dropped. Back the
-- database up before this runs anywhere that holds real customers.

-- The money first: the ledger points at top-ups, at tickets and at usage events,
-- so it goes before all three.
DROP TABLE service_ledger;
DROP TABLE service_top_ups;
DROP TABLE service_wallets;
DROP TABLE service_model_prices;
DROP TABLE service_prices;

-- What service keys and ticket keys sent. Ticket keys counted their requests as
-- Workspace usage, so the scope alone does not find them: they are found by the
-- key. This runs before the keys are deleted, since deleting a key would leave its
-- events behind with no key.
DELETE FROM gateway_usage_events
WHERE scope = 'service'
   OR gateway_key_id IN (SELECT id FROM gateway_keys WHERE kind IN ('service', 'ticket'));

DELETE FROM gateway_keys WHERE kind IN ('service', 'ticket');

-- A key is a workspace key or an organization key again. Only an organization key
-- names an organization (`gateway_keys_kind_organization_check` stays), and none
-- expires.
ALTER TABLE gateway_keys
    DROP CONSTRAINT gateway_keys_ticket_check,
    DROP CONSTRAINT gateway_keys_kind_check;
DROP INDEX gateway_keys_listing_idx;
ALTER TABLE gateway_keys
    DROP COLUMN listing_id,
    DROP COLUMN expires_at;
ALTER TABLE gateway_keys
    ADD CONSTRAINT gateway_keys_kind_check
    CHECK (kind IN ('workspace', 'organization'));

-- The tickets themselves, now that no key and no ledger row points at one.
DROP TABLE service_listings;

-- Usage is counted in the Workspace or in an organization.
ALTER TABLE gateway_usage_events
    DROP CONSTRAINT gateway_usage_events_scope_check,
    ADD CONSTRAINT gateway_usage_events_scope_check
    CHECK (scope IN ('workspace', 'organization'));

-- No account belongs to a stock the platform serves its customers from.
DROP INDEX agent_connections_service_stock_idx;
ALTER TABLE agent_connections
    DROP COLUMN service_stock;
