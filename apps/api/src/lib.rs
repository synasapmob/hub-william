//! Hub William backend.
//!
//! `api` holds every feature that exposes endpoints and assembles them; `utils`
//! holds shared leaf modules; `core` holds the infrastructure beneath both.

mod api;
mod core;
mod utils;

// The public surface used by the binary, the export tool and the examples.
pub use crate::api::{
    ApiDoc, ProviderCredentialRefreshResult, ProviderCredentialRefreshStatus,
    ProviderCredentialRefreshSummary, app, expire_abandoned_authorizations,
    refresh_all_provider_credentials, refresh_due_provider_credentials,
    refresh_nightly_provider_credentials, refresh_stored_connection_metadata,
    stop_credential_sweeps, wait_for_credential_refreshes,
};
pub use crate::core::{AppConfig, AppState, gateway_http_client};
