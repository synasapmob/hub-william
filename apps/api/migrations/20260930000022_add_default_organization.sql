-- The default organization is the one a member's Organization pages open with.
-- It lives on the membership row, so leaving an organization, being removed from
-- it or the organization being deleted clears it without a separate cleanup.
ALTER TABLE organization_memberships
    ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT organization_memberships_default_is_accepted
        CHECK (NOT is_default OR status = 'accepted');

CREATE UNIQUE INDEX organization_memberships_one_default_per_user_idx
    ON organization_memberships (user_id) WHERE is_default;
