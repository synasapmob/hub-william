use axum::{
    Router,
    routing::{get, post},
};
use utoipa::OpenApi;

use crate::core::AppState;

use super::{login, logout, refresh, register, session};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/session", get(session))
        .route("/auth/logout", post(logout))
        .route("/auth/refresh", post(refresh))
}

#[derive(OpenApi)]
#[openapi(
    paths(
        super::register,
        super::login,
        super::session,
        super::logout,
        super::refresh
    ),
    components(schemas(
        super::AuthenticatedUser,
        super::LoginRequest,
        super::RegisterRequest,
        super::SessionResponse
    )),
    tags((name = "auth", description = "Browser account sessions"))
)]
pub(crate) struct AuthApi;
