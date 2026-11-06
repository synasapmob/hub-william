-- Hub William sells tickets. A staff member connects one of their own agent
-- accounts and puts it on sale for a number of days at a price. A customer who
-- buys it pays from the wallet once and gets a key that runs on that one account
-- until the days are up. Nothing is charged by the token.
--
-- Selling a stock of Hub keys (`service_stock_keys`, the one before this) is
-- given up: the account itself is what is sold.
DROP TABLE service_stock_keys;

CREATE TABLE service_listings (
    id UUID PRIMARY KEY,
    provider TEXT NOT NULL
        CHECK (provider IN ('chatgpt', 'gemini', 'claude', 'deepseek', 'grok', 'groq')),
    -- The account that is sold. It goes to NULL if its owner disconnects it: an
    -- unsold listing is then no longer for sale, and a sold one stays in the history.
    connection_id UUID REFERENCES agent_connections(id) ON DELETE SET NULL,
    seller_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    -- How long the key a customer buys lasts, from the moment it is bought.
    days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 365),
    -- In micro-dollars, always whole cents, as a top-up is.
    price_micro BIGINT NOT NULL
        CHECK (price_micro BETWEEN 10000 AND 10000000000 AND price_micro % 10000 = 0),
    listed BOOLEAN NOT NULL DEFAULT TRUE,
    -- What the provider said the account had left when it was verified, as the
    -- Agents page reads it: a list of {label, value, detail}.
    quota JSONB NOT NULL DEFAULT '[]'::jsonb,
    quota_captured_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The sale. A listing is sold once, and then it is history.
    sold_at TIMESTAMPTZ,
    buyer_id UUID REFERENCES users(id) ON DELETE SET NULL,
    sold_price_micro BIGINT CHECK (sold_price_micro IS NULL OR sold_price_micro > 0),
    CHECK ((sold_at IS NULL) = (sold_price_micro IS NULL))
);

-- An account is on sale in one listing at a time.
CREATE UNIQUE INDEX service_listings_open_connection_idx
    ON service_listings (connection_id)
    WHERE sold_at IS NULL AND connection_id IS NOT NULL;

CREATE INDEX service_listings_open_idx
    ON service_listings (provider, created_at)
    WHERE sold_at IS NULL;

CREATE INDEX service_listings_sold_idx
    ON service_listings (sold_at DESC)
    WHERE sold_at IS NOT NULL;

-- A fourth kind of key: the one a customer gets for a ticket. It is served by the
-- account of its listing and by no other, is free to use, and stops working when
-- `expires_at` has passed.
ALTER TABLE gateway_keys
    DROP CONSTRAINT gateway_keys_kind_check;
ALTER TABLE gateway_keys
    ADD CONSTRAINT gateway_keys_kind_check
    CHECK (kind IN ('workspace', 'organization', 'service', 'ticket'));
ALTER TABLE gateway_keys
    ADD COLUMN expires_at TIMESTAMPTZ,
    ADD COLUMN listing_id UUID REFERENCES service_listings(id) ON DELETE CASCADE,
    ADD CONSTRAINT gateway_keys_ticket_check
        CHECK ((kind = 'ticket') = (listing_id IS NOT NULL AND expires_at IS NOT NULL));

CREATE INDEX gateway_keys_listing_idx
    ON gateway_keys (listing_id)
    WHERE listing_id IS NOT NULL;

-- Buying a ticket is one more way money leaves the wallet, once per listing.
ALTER TABLE service_ledger
    DROP CONSTRAINT service_ledger_kind_check;
ALTER TABLE service_ledger
    ADD CONSTRAINT service_ledger_kind_check
    CHECK (kind IN ('top_up', 'usage', 'exchange', 'withdraw', 'purchase'));
ALTER TABLE service_ledger
    ADD COLUMN listing_id UUID REFERENCES service_listings(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX service_ledger_purchase_idx
    ON service_ledger (listing_id)
    WHERE kind = 'purchase' AND listing_id IS NOT NULL;
