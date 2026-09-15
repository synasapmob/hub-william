ALTER TABLE telegram_products
    ADD COLUMN category VARCHAR(64);

-- A contact that blocked the bot answers 403 forever. Recording it stops the
-- next announcement from spending a send on them.
ALTER TABLE telegram_contacts
    ADD COLUMN blocked_at TIMESTAMPTZ;

CREATE INDEX telegram_contacts_reachable_idx
    ON telegram_contacts (chat_id)
    WHERE blocked_at IS NULL;

-- Stock held by an order that is still awaiting payment and has not expired.
-- Selling against this rather than against the raw count is what stops two
-- buyers from each taking the last unit.
CREATE INDEX telegram_orders_reserved_idx
    ON telegram_orders (item_id, expires_at)
    WHERE status = 'awaiting_payment';

UPDATE telegram_products SET category = 'AI Tools';
