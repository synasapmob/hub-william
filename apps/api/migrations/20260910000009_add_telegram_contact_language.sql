ALTER TABLE telegram_contacts
    ADD COLUMN preferred_language VARCHAR(2)
        CHECK (preferred_language IS NULL OR preferred_language IN ('en', 'vi'));
