-- Google answers a Code Assist verification challenge with a link the account
-- owner must open to verify. It is the only action the Hub cannot take on the
-- owner's behalf, so a reconnect-required account carries it to the UI.
ALTER TABLE agent_connections
    ADD COLUMN validation_url TEXT;
