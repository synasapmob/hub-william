CREATE TABLE telegram_contacts (
    telegram_user_id BIGINT PRIMARY KEY CHECK (telegram_user_id > 0),
    chat_id BIGINT NOT NULL CHECK (chat_id > 0),
    username VARCHAR(32),
    first_name VARCHAR(128) NOT NULL,
    last_name VARCHAR(128),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX telegram_contacts_last_seen_at_idx ON telegram_contacts (last_seen_at DESC);
