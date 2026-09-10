ALTER TABLE agent_connections
    ADD COLUMN capacity INTEGER NOT NULL DEFAULT 6
    CHECK (capacity BETWEEN 2 AND 100);

CREATE TABLE agent_pool_join_requests (
    id UUID PRIMARY KEY,
    connection_id UUID NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
    requester_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram VARCHAR(80) NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (connection_id, requester_user_id)
);

CREATE INDEX agent_pool_join_requests_connection_status_idx
    ON agent_pool_join_requests(connection_id, status);
