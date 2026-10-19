//! Infrastructure every other module builds on: configuration, the error type,
//! application state and the CORS policy. `core` imports nothing else from the
//! crate, so dependencies point one way: `api` -> `utils` -> `core`.

mod config;
pub(crate) mod cors;
mod error;
mod state;

pub use config::AppConfig;
pub(crate) use cors::browser_origins;
pub use error::{ApiError, ErrorResponse};
pub use state::{AppState, gateway_http_client};
