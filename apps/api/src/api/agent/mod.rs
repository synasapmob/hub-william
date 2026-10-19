//! Provider agents: the connected provider accounts of a user (`connections`) and
//! the pools that share them with other users (`pools`).

mod connections;
mod pools;
mod routes;
pub(crate) mod usage;

// Used by other features (gateway, usage, organizations, playground).
pub(crate) use connections::{
    ANTIGRAVITY_CLIENT_VERSION, CredentialLookup, PROVIDER_LOGIN_REQUIRED_MESSAGE,
    gateway_credential, load_gemini_code_assist, mark_gemini_verification_required,
    mark_reauthorization_required_if_current, provider_credential, recover_rejected_credential,
};
pub(crate) use pools::AgentPoolUsageMetric;
pub(crate) use routes::{AgentApi, routes};

// Used by the binary and the examples through the crate root.
pub use connections::{
    ProviderCredentialRefreshResult, ProviderCredentialRefreshStatus,
    ProviderCredentialRefreshSummary, expire_abandoned_authorizations,
    refresh_all_provider_credentials, refresh_due_provider_credentials,
    refresh_nightly_provider_credentials, refresh_stored_connection_metadata,
    stop_credential_sweeps, wait_for_credential_refreshes,
};

// The organization database tests drive these handlers directly.
#[cfg(all(test, feature = "database-tests"))]
pub(crate) use connections::{
    AgentConnection, AgentConnectionStatus, ConnectDeepseekRequest, connect_deepseek, disconnect,
    list_connections,
};
