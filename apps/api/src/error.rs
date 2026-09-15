use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorResponse {
    pub code: String,
    pub message: String,
}

#[derive(Debug)]
pub enum ApiError {
    Conflict,
    Forbidden,
    GatewayUnauthorized,
    InvalidCredentials,
    NotFound,
    Provider(String),
    RateLimited,
    ShareExhausted,
    Unauthorized,
    Validation(&'static str),
    Internal,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, payload) = match self {
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
            Self::GatewayUnauthorized => (
                StatusCode::UNAUTHORIZED,
                ErrorResponse {
                    code: "invalid_gateway_key".to_owned(),
                    message: "Provide an active Hub William gateway key.".to_owned(),
                },
            ),
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
            Self::ShareExhausted => (
                StatusCode::TOO_MANY_REQUESTS,
                ErrorResponse {
                    code: "pool_share_exhausted".to_owned(),
                    message: "Your share of this pool's live usage window is used up.".to_owned(),
                },
            ),
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

        (status, Json(payload)).into_response()
    }
}
