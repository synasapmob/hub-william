-- What a buyer is told about using a package once they have paid. The shop writes
-- it once, as it wants it read, so it is the same for a reader of either language.
-- Blank means nothing is sent.
ALTER TABLE telegram_products
    ADD COLUMN guide TEXT NOT NULL DEFAULT ''
        CHECK (char_length(guide) <= 1000);
