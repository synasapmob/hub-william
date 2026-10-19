//! Hub William backend.
//!
//! Each feature lives in its own folder and wires itself in through `routes()`
//! and an OpenAPI fragment in its `routes.rs`. `core` holds what they share.

mod agent;
mod auth;
mod core;
mod gateway;
mod helpers;
mod organizations;
mod playground;
mod telegram;
mod tts;

// The public surface used by the binary, the export tool and the examples.
pub use crate::agent::{
    ProviderCredentialRefreshResult, ProviderCredentialRefreshStatus,
    ProviderCredentialRefreshSummary, expire_abandoned_authorizations,
    refresh_all_provider_credentials, refresh_due_provider_credentials,
    refresh_nightly_provider_credentials, refresh_stored_connection_metadata,
    stop_credential_sweeps, wait_for_credential_refreshes,
};
pub use crate::core::{ApiDoc, AppConfig, AppState, app, gateway_http_client};
