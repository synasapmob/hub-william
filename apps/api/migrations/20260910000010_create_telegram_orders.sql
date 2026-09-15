CREATE TABLE telegram_orders (
    id UUID PRIMARY KEY,
    reference VARCHAR(16) NOT NULL UNIQUE CHECK (reference ~ '^[A-Z0-9]+$'),
    telegram_user_id BIGINT NOT NULL REFERENCES telegram_contacts(telegram_user_id) ON DELETE CASCADE,
    chat_id BIGINT NOT NULL CHECK (chat_id > 0),
    item_id VARCHAR(64) NOT NULL,
    item_title VARCHAR(128) NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_vnd BIGINT NOT NULL CHECK (unit_price_vnd >= 0),
    total_vnd BIGINT NOT NULL CHECK (total_vnd >= 0),
    status VARCHAR(24) NOT NULL DEFAULT 'awaiting_payment'
        CHECK (status IN ('awaiting_payment', 'paid', 'cancelled')),
    expires_at TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT telegram_orders_paid_at_matches_status
        CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);

CREATE INDEX telegram_orders_contact_created_idx
    ON telegram_orders (telegram_user_id, created_at DESC);

-- A SePay transfer is matched against every order still awaiting payment, so
-- that lookup is the one this table is read by most often.
CREATE INDEX telegram_orders_awaiting_payment_idx
    ON telegram_orders (reference)
    WHERE status = 'awaiting_payment';

CREATE TABLE telegram_payments (
    id UUID PRIMARY KEY,
    sepay_transaction_id BIGINT NOT NULL UNIQUE,
    order_id UUID REFERENCES telegram_orders(id) ON DELETE SET NULL,
    gateway VARCHAR(64) NOT NULL,
    account_number VARCHAR(64),
    amount_vnd BIGINT NOT NULL,
    content TEXT NOT NULL,
    transfer_type VARCHAR(8) NOT NULL,
    bank_reference VARCHAR(64),
    transferred_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX telegram_payments_order_idx ON telegram_payments (order_id);
CREATE INDEX telegram_payments_received_idx ON telegram_payments (received_at DESC);
