//! Infrastructure every other module builds on: configuration, the error type,
//! application state, the CORS policy and rate limiting. `core` imports nothing
//! else from the crate, so dependencies point one way: `api` -> `utils` -> `core`.

pub(crate) mod client_ip;
mod config;
pub(crate) mod cors;
mod error;
pub(crate) mod rate_limit;
mod state;

pub use config::AppConfig;
pub(crate) use cors::browser_origins;
pub(crate) use error::GatewayAuthFailed;
pub use error::{ApiError, ErrorResponse};
pub use state::{AppState, gateway_http_client};
