//! The HTTP surface: every feature that exposes endpoints, plus the composition
//! root that assembles them. A feature registers itself from its own `routes.rs`
//! (`routes()` and an `...Api` OpenAPI fragment); `router.rs` and `openapi.rs` are
//! the only files that list features.

mod agent;
mod auth;
mod gateway;
mod health;
mod limits;
#[cfg(test)]
mod limits_tests;
mod openapi;
mod organizations;
mod playground;
mod reel;
mod router;
mod telegram;
#[cfg(test)]
mod tests;
mod tts;

pub use openapi::ApiDoc;
pub use router::app;

// Used by the binary and the examples through the crate root.
pub use agent::{
    ProviderCredentialRefreshResult, ProviderCredentialRefreshStatus,
    ProviderCredentialRefreshSummary, expire_abandoned_authorizations,
    refresh_all_provider_credentials, refresh_due_provider_credentials,
    refresh_nightly_provider_credentials, refresh_stored_connection_metadata,
    stop_credential_sweeps, wait_for_credential_refreshes,
};
