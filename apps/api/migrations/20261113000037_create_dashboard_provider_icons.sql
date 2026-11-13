-- Which icon a provider shows in the dashboard. The provider is named by its slug,
-- so the Telegram providers and the agents of Hub William (`chatgpt`, `claude`, ...)
-- share one table, and an icon can be chosen before a provider has its first
-- package. The icon is the name of an object in the icon bucket, never an address:
-- where the bucket is public is a setting, so a move to another domain changes no row.
CREATE TABLE dashboard_provider_icons (
    provider VARCHAR(64) PRIMARY KEY CHECK (provider ~ '^[a-z0-9-]+$'),
    icon VARCHAR(128) NOT NULL CHECK (icon ~ '^icons/[a-z0-9][a-z0-9._-]*$'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
