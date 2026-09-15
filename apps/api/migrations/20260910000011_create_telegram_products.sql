CREATE TABLE telegram_providers (
    id UUID PRIMARY KEY,
    slug VARCHAR(32) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
    name VARCHAR(64) NOT NULL,
    listed BOOLEAN NOT NULL DEFAULT TRUE,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE telegram_products (
    id UUID PRIMARY KEY,
    provider_id UUID NOT NULL REFERENCES telegram_providers(id) ON DELETE CASCADE,
    slug VARCHAR(64) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
    plan VARCHAR(64) NOT NULL,
    variant VARCHAR(32),
    detail VARCHAR(32),
    warranty VARCHAR(8) NOT NULL CHECK (warranty IN ('WF', 'NW', 'W7D')),
    warranty_note_en TEXT NOT NULL,
    warranty_note_vi TEXT NOT NULL,
    price_vnd BIGINT NOT NULL CHECK (price_vnd >= 0),
    available INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
    hot BOOLEAN NOT NULL DEFAULT FALSE,
    listed BOOLEAN NOT NULL DEFAULT TRUE,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX telegram_products_provider_idx
    ON telegram_products (provider_id, position, created_at);

-- Every stock top-up is kept, so an announcement can be traced back to the
-- change that caused it and stock movement is auditable.
CREATE TABLE telegram_restocks (
    id UUID PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES telegram_products(id) ON DELETE CASCADE,
    added INTEGER NOT NULL CHECK (added > 0),
    available_after INTEGER NOT NULL CHECK (available_after >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX telegram_restocks_product_idx
    ON telegram_restocks (product_id, created_at DESC);

-- The catalogue that until now lived in apps/telegram/src/catalog.rs. Seeding
-- it here keeps the shop identical across the move rather than emptying it.
INSERT INTO telegram_providers (id, slug, name, position) VALUES
    (gen_random_uuid(), 'chatgpt', 'ChatGPT', 1),
    (gen_random_uuid(), 'claude', 'Claude', 2),
    (gen_random_uuid(), 'grok', 'Grok', 3);

INSERT INTO telegram_products (
    id, provider_id, slug, plan, variant, detail, warranty,
    warranty_note_en, warranty_note_vi, price_vnd, available, hot, position
)
SELECT
    gen_random_uuid(),
    provider.id,
    seed.slug,
    seed.plan,
    seed.variant,
    seed.detail,
    seed.warranty,
    seed.warranty_note_en,
    seed.warranty_note_vi,
    seed.price_vnd,
    seed.available,
    seed.hot,
    seed.position
FROM (
    VALUES
        ('claude', 'claude-max-x20', 'MAX X20', 'Personal', '1M', 'WF',
         'Activated straight on your own account, with a full warranty for the whole term.',
         'Active trực tiếp trên tài khoản chính chủ của bạn, bảo hành đầy đủ trọn thời hạn.',
         135000::BIGINT, 53, TRUE, 1),
        ('claude', 'claude-max-x5', 'MAX X5', NULL, NULL, 'W7D',
         'Warranty is a login check within 1 hour (after that hour there is no warranty under any circumstance).',
         'Bảo hành login check 1 tiếng (sau 1 tiếng kể từ khi mua không bảo hành mọi trường hợp)',
         79000::BIGINT, 27, FALSE, 2),
        ('claude', 'claude-pro', 'Pro', NULL, NULL, 'NW',
         'Warranty is a login check within 1 hour (after that hour there is no warranty under any circumstance).',
         'Bảo hành login check 1 tiếng (sau 1 tiếng kể từ khi mua không bảo hành mọi trường hợp)',
         49000::BIGINT, 41, FALSE, 3),
        ('chatgpt', 'chatgpt-plus', 'Plus', 'Personal', NULL, 'W7D',
         'Warranty is a login check within 1 hour (after that hour there is no warranty under any circumstance).',
         'Bảo hành login check 1 tiếng (sau 1 tiếng kể từ khi mua không bảo hành mọi trường hợp)',
         299000::BIGINT, 12, TRUE, 1),
        ('grok', 'grok-supergrok', 'SuperGrok', 'Personal', NULL, 'NW',
         'Warranty is a login check within 1 hour (after that hour there is no warranty under any circumstance).',
         'Bảo hành login check 1 tiếng (sau 1 tiếng kể từ khi mua không bảo hành mọi trường hợp)',
         259000::BIGINT, 0, FALSE, 1)
) AS seed (
    provider_slug, slug, plan, variant, detail, warranty,
    warranty_note_en, warranty_note_vi, price_vnd, available, hot, position
)
JOIN telegram_providers AS provider ON provider.slug = seed.provider_slug;
