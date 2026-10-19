use axum::http::{
    HeaderValue, Method,
    header::{AUTHORIZATION, CONTENT_TYPE},
};
use tower_http::cors::{AllowOrigin, CorsLayer, ExposeHeaders};

use super::AppConfig;

pub(crate) fn browser_origins(config: &AppConfig) -> Vec<HeaderValue> {
    let mut browser_origins = vec![config.frontend_origin.clone()];
    if !config.cookie_secure {
        for origin in [
            "http://localhost:5173".parse().expect("valid local origin"),
            "http://127.0.0.1:5173".parse().expect("valid local origin"),
            "http://localhost:5174".parse().expect("valid local origin"),
            "http://127.0.0.1:5174".parse().expect("valid local origin"),
            "http://localhost:3000".parse().expect("valid local origin"),
            "http://127.0.0.1:3000".parse().expect("valid local origin"),
        ] {
            if !browser_origins.contains(&origin) {
                browser_origins.push(origin);
            }
        }
    }
    browser_origins
}

/// Browser CORS policy. `exposed_headers` are the response headers a feature
/// lets the frontend read.
pub(crate) fn layer(config: &AppConfig, exposed_headers: impl Into<ExposeHeaders>) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(browser_origins(config)))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE])
        .expose_headers(exposed_headers)
        .allow_credentials(true)
}
