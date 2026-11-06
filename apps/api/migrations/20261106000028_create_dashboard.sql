-- The shop's dashboard (apps/dashboard): who may sign in to it, the pictures of
-- what it sells, and a record of every change of a product's count.

-- A staff member is an ordinary account with a role in the dashboard. The owners
-- named in DASHBOARD_OWNER_USERNAMES need no row: they are owners whatever this
-- table says, so the first owner is never locked out and never has to be seeded.
CREATE TABLE dashboard_staff (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier', 'stock-keeper')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Pictures live in the database, so the shop needs no object store. The type is
-- the one read from the bytes, never the one the uploader claimed, and SVG is
-- left out because it can carry script.
CREATE TABLE dashboard_images (
    id UUID PRIMARY KEY,
    content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    data BYTEA NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 5242880),
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE telegram_products
    ADD COLUMN image_id UUID REFERENCES dashboard_images(id) ON DELETE SET NULL;

-- `telegram_restocks` only knows stock coming in. The dashboard also takes stock
-- away, and wants to know who did either, so each change of a count is kept here.
CREATE TABLE telegram_stock_changes (
    id UUID PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES telegram_products(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL CHECK (delta <> 0),
    available_after INTEGER NOT NULL CHECK (available_after >= 0),
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX telegram_stock_changes_product_idx
    ON telegram_stock_changes (product_id, created_at DESC);
