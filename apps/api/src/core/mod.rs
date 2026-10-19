//! Infrastructure shared by every feature: configuration, error type, application
//! state, the HTTP surface (router, CORS) and the OpenAPI document. Features depend
//! on `core`; `core` composes features only in `router.rs` and `openapi.rs`.

mod config;
mod cors;
mod error;
pub(crate) mod health;
mod openapi;
mod router;
mod state;
#[cfg(test)]
mod tests;

pub use config::AppConfig;
pub(crate) use cors::browser_origins;
pub use error::{ApiError, ErrorResponse};
pub use openapi::ApiDoc;
pub use router::app;
pub use state::{AppState, gateway_http_client};
