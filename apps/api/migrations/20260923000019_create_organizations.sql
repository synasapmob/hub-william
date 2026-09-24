CREATE TABLE organizations (
    id UUID PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT organizations_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE TABLE organization_memberships (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL CHECK (role IN ('owner', 'member')),
    status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'accepted')),
    invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    joined_at TIMESTAMPTZ,
    CONSTRAINT organization_memberships_unique_user UNIQUE (org_id, user_id),
    CONSTRAINT organization_memberships_owner_accepted
        CHECK (role <> 'owner' OR status = 'accepted'),
    CONSTRAINT organization_memberships_joined_at_matches_status
        CHECK ((status = 'accepted') = (joined_at IS NOT NULL))
);

CREATE UNIQUE INDEX organization_memberships_one_owner_idx
    ON organization_memberships (org_id) WHERE role = 'owner';
CREATE INDEX organization_memberships_user_status_idx
    ON organization_memberships (user_id, status, created_at);

CREATE TABLE organization_agents (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, connection_id),
    CONSTRAINT organization_agents_member_owner_fk
        FOREIGN KEY (org_id, owner_user_id)
        REFERENCES organization_memberships (org_id, user_id) ON DELETE CASCADE
);

CREATE INDEX organization_agents_connection_idx
    ON organization_agents (connection_id);

-- A reconnect may transfer a connection to another Hub user. Its former owner
-- cannot grant organization access on behalf of the new owner.
CREATE FUNCTION remove_organization_shares_on_connection_transfer()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        DELETE FROM organization_agents WHERE connection_id = OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER agent_connection_owner_transfer_removes_organization_shares
BEFORE UPDATE OF user_id ON agent_connections
FOR EACH ROW EXECUTE FUNCTION remove_organization_shares_on_connection_transfer();

CREATE TABLE organization_usage_events (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id UUID REFERENCES agent_connections(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT,
    input_tokens BIGINT CHECK (input_tokens >= 0),
    output_tokens BIGINT CHECK (output_tokens >= 0),
    cached_tokens BIGINT CHECK (cached_tokens >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX organization_usage_events_org_created_idx
    ON organization_usage_events (org_id, created_at DESC);
CREATE INDEX organization_usage_events_org_user_created_idx
    ON organization_usage_events (org_id, user_id, created_at DESC);
CREATE INDEX organization_usage_events_org_connection_created_idx
    ON organization_usage_events (org_id, connection_id, created_at DESC);

ALTER TABLE gateway_keys
    ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX gateway_keys_organization_id_idx
    ON gateway_keys (organization_id) WHERE organization_id IS NOT NULL;
