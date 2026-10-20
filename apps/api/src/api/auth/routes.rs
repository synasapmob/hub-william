use axum::{
    Router,
    middleware::from_fn_with_state,
    routing::{get, post},
};
use utoipa::OpenApi;

use crate::core::{AppState, rate_limit::limit_by_ip};

use crate::api::limits::{Limit, UserLimit, ip_limit, limit_by_user};

use super::{login, logout, refresh, register, session};

pub(crate) fn routes(state: &AppState) -> Router<AppState> {
    let register_limit = ip_limit(state, Limit::AuthRegister);
    let login_limit = ip_limit(state, Limit::AuthLogin);
    let refresh_limit = UserLimit::new(state, Limit::AuthRefresh);

    Router::new()
        .route(
            "/auth/register",
            post(register).layer(from_fn_with_state(register_limit, limit_by_ip)),
        )
        .route(
            "/auth/login",
            post(login).layer(from_fn_with_state(login_limit, limit_by_ip)),
        )
        .route("/auth/session", get(session))
        .route("/auth/logout", post(logout))
        .route(
            "/auth/refresh",
            post(refresh).layer(from_fn_with_state(refresh_limit, limit_by_user)),
        )
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
