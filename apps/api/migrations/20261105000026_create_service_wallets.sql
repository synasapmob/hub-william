-- The SERVICE product: customers rent agents that the platform owns, and pay
-- from a wallet. All money is an integer number of micro-dollars (1 USD =
-- 1,000,000), so no amount is ever a fractional number.
--
-- `wallet_micro` is the customer's cash: money added with a top-up and returned
-- by a withdrawal. `credit_micro` is the part exchanged for use; requests spend
-- it. `credit_capacity_micro` is the size of the current tank for the progress
-- bar: it equals the credit right after an exchange and stays put while credit
-- is spent, so (capacity - credit) is what the current tank has used.
CREATE TABLE service_wallets (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    wallet_micro BIGINT NOT NULL DEFAULT 0 CHECK (wallet_micro >= 0),
    credit_micro BIGINT NOT NULL DEFAULT 0 CHECK (credit_micro >= 0),
    credit_capacity_micro BIGINT NOT NULL DEFAULT 0 CHECK (credit_capacity_micro >= credit_micro),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every movement of money between the outside, the wallet and the credit. Rows
-- are only ever added. `*_after_micro` is the balance right after the movement,
-- so the history can be checked against the current balances.
CREATE TABLE service_ledger (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('top_up', 'exchange', 'withdraw')),
    amount_micro BIGINT NOT NULL CHECK (amount_micro > 0),
    wallet_after_micro BIGINT NOT NULL CHECK (wallet_after_micro >= 0),
    credit_after_micro BIGINT NOT NULL CHECK (credit_after_micro >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX service_ledger_user_created_idx
    ON service_ledger (user_id, created_at DESC);

-- Price of one million tokens, in micro-dollars, by kind of token. The row
-- `default` applies to every agent until an agent gets a row of its own.
CREATE TABLE service_prices (
    provider TEXT PRIMARY KEY,
    input_micro_per_million BIGINT NOT NULL CHECK (input_micro_per_million >= 0),
    cached_micro_per_million BIGINT NOT NULL CHECK (cached_micro_per_million >= 0),
    output_micro_per_million BIGINT NOT NULL CHECK (output_micro_per_million >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO service_prices
    (provider, input_micro_per_million, cached_micro_per_million, output_micro_per_million)
VALUES ('default', 600000, 60000, 4700000);
