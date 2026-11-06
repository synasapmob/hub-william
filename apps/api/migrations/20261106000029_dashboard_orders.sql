-- What the dashboard needs to know about an order beyond what the bot did with
-- it: how it was paid, and who in the shop settled or cancelled it.

ALTER TABLE telegram_orders
    ADD COLUMN payment_method TEXT
        CHECK (payment_method IN ('bank_transfer', 'usdt', 'cash')),
    -- The member of staff who marked it paid or cancelled it. Empty for an order
    -- SePay settled by itself, and for one the buyer cancelled in the chat.
    ADD COLUMN handled_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Until now only SePay settled an order, and SePay is a bank transfer.
UPDATE telegram_orders SET payment_method = 'bank_transfer' WHERE status = 'paid';

-- A paid order is always paid some way.
ALTER TABLE telegram_orders
    ADD CONSTRAINT telegram_orders_paid_has_a_method
        CHECK (status <> 'paid' OR payment_method IS NOT NULL);

-- The queue is read by status, oldest first; history by when it was paid.
CREATE INDEX telegram_orders_status_created_idx
    ON telegram_orders (status, created_at);
CREATE INDEX telegram_orders_paid_at_idx
    ON telegram_orders (paid_at DESC)
    WHERE status = 'paid';
