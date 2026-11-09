-- A package can hand the buyer an account the moment their payment lands. The
-- accounts are loaded in advance, one `email|password` line each, and kept
-- encrypted: the key lives in the environment, never in this database, so a copy
-- of the database alone shows nothing readable.
--
-- The flag is set when the package is made and does not change afterwards. The
-- count a buyer sees for such a package is the number of accounts not yet sold, so
-- flipping the flag on a package that already has a hand-set count would leave
-- the two disagreeing.
ALTER TABLE telegram_products
    ADD COLUMN delivers_accounts BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE telegram_stock_accounts (
    id UUID PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES telegram_products(id) ON DELETE CASCADE,
    -- AES-256-GCM of the `email|password` line. The row's id is bound in as the
    -- associated data, so a ciphertext copied onto another row does not open.
    nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
    ciphertext BYTEA NOT NULL,
    -- A keyed hash of the line, so loading the same account twice is noticed
    -- without keeping it readable.
    fingerprint BYTEA NOT NULL CHECK (octet_length(fingerprint) = 32),
    -- A keyed hash of the email alone, so a search for an email in full finds its
    -- accounts without reading any. Accounts may share an email: a line is a unit
    -- of stock whatever its email, and only the same line twice is a repeat.
    email_fingerprint BYTEA NOT NULL CHECK (octet_length(email_fingerprint) = 32),
    -- Who loaded it. It goes to NULL if that person's account is deleted.
    loaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    -- The order the account was handed to, once it has been.
    order_reference TEXT,
    sold_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT telegram_stock_accounts_sold_together
        CHECK ((order_reference IS NULL) = (sold_at IS NULL)),
    UNIQUE (product_id, fingerprint)
);

-- To find the accounts of an email.
CREATE INDEX telegram_stock_accounts_email
    ON telegram_stock_accounts (email_fingerprint);

-- Each time someone with the right to looked at an account's password. It has no
-- foreign key to the account, so the record outlives an account that is deleted.
CREATE TABLE telegram_stock_account_views (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL,
    viewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The accounts still for sale, oldest first.
CREATE INDEX telegram_stock_accounts_unsold
    ON telegram_stock_accounts (product_id, created_at)
    WHERE order_reference IS NULL;
