use std::time::Duration;

use axum::{
    Json,
    http::{HeaderValue, StatusCode, header::RETRY_AFTER},
    response::IntoResponse,
};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorResponse {
    pub code: String,
    pub message: String,
}

/// Response extension set when a gateway key was missing or wrong, so the
/// gateway rate limiter can count failed attempts without parsing bodies.
#[derive(Clone, Copy, Debug)]
pub(crate) struct GatewayAuthFailed;

#[derive(Debug)]
pub enum ApiError {
    Busy,
    Conflict,
    Forbidden,
    GatewayUnauthorized,
    InvalidCredentials,
    NotFound,
    Provider(String),
    RateLimited,
    /// Carries the whole seconds the caller should wait before retrying.
    TooManyRequests(u64),
    Unauthorized,
    Validation(&'static str),
    Internal,
}

impl ApiError {
    pub(crate) fn too_many_requests(wait: Duration) -> Self {
        Self::TooManyRequests(wait.as_secs_f64().ceil().max(1.0) as u64)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let mut retry_after = None;
        let mut gateway_auth_failed = false;
        let (status, payload) = match self {
            Self::Busy => (
                StatusCode::SERVICE_UNAVAILABLE,
                ErrorResponse {
                    code: "busy".to_owned(),
                    message: "Too many downloads are running. Try again in a moment.".to_owned(),
                },
            ),
            Self::Conflict => (
                StatusCode::CONFLICT,
                ErrorResponse {
                    code: "username_taken".to_owned(),
                    message: "That username is already registered.".to_owned(),
                },
            ),
            Self::Forbidden => (
                StatusCode::FORBIDDEN,
                ErrorResponse {
                    code: "forbidden".to_owned(),
                    message: "You do not have permission to perform this action.".to_owned(),
                },
            ),
            Self::GatewayUnauthorized => {
                gateway_auth_failed = true;
                (
                    StatusCode::UNAUTHORIZED,
                    ErrorResponse {
                        code: "invalid_gateway_key".to_owned(),
                        message: "Provide an active Hub William gateway key.".to_owned(),
                    },
                )
            }
            Self::InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                ErrorResponse {
                    code: "invalid_credentials".to_owned(),
                    message: "The username or password is incorrect.".to_owned(),
                },
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                ErrorResponse {
                    code: "not_found".to_owned(),
                    message: "The requested resource was not found.".to_owned(),
                },
            ),
            Self::Provider(message) => (
                StatusCode::BAD_GATEWAY,
                ErrorResponse {
                    code: "provider_unavailable".to_owned(),
                    message,
                },
            ),
            Self::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                ErrorResponse {
                    code: "all_pools_rate_limited".to_owned(),
                    message: "Every accessible pool for this provider is cooling down.".to_owned(),
                },
            ),
            Self::TooManyRequests(seconds) => {
                retry_after = Some(seconds);
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    ErrorResponse {
                        code: "rate_limited".to_owned(),
                        message: format!("Too many requests. Try again in {seconds} seconds."),
                    },
                )
            }
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                ErrorResponse {
                    code: "unauthorized".to_owned(),
                    message: "Log in to continue.".to_owned(),
                },
            ),
            Self::Validation(message) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                ErrorResponse {
                    code: "validation_error".to_owned(),
                    message: message.to_owned(),
                },
            ),
            Self::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ErrorResponse {
                    code: "internal_error".to_owned(),
                    message: "The server could not complete the request.".to_owned(),
                },
            ),
        };

        let mut response = (status, Json(payload)).into_response();
        if let Some(seconds) = retry_after {
            response
                .headers_mut()
                .insert(RETRY_AFTER, HeaderValue::from(seconds));
        }
        if gateway_auth_failed {
            response.extensions_mut().insert(GatewayAuthFailed);
        }

        response
    }
}
