-- Paying the wallet in by card. A top-up is opened as `pending` when the customer
-- is sent to Stripe Checkout, and becomes `paid` once, when Stripe's signed
-- webhook says the payment was made. The wallet is credited in that same
-- transaction, so a webhook that arrives twice credits it once.
CREATE TABLE service_top_ups (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- What the customer was asked to pay, in micro-dollars, always whole cents.
    amount_micro BIGINT NOT NULL CHECK (amount_micro > 0 AND amount_micro % 10000 = 0),
    -- The Checkout Session, set once Stripe has opened it.
    stripe_session_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ
);

CREATE INDEX service_top_ups_user_idx ON service_top_ups (user_id, created_at DESC);

-- The ledger row of a top-up that was paid points at it, once: a top-up is
-- credited once.
ALTER TABLE service_ledger
    ADD COLUMN top_up_id UUID REFERENCES service_top_ups(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX service_ledger_top_up_idx
    ON service_ledger (top_up_id) WHERE top_up_id IS NOT NULL;
