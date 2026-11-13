//! The shop's dashboard (`apps/dashboard`): who may use it, what each role may do,
//! and the endpoints behind its pages. Everything here is for signed-in staff. The
//! Telegram bot keeps its own internal routes and none of this reaches it.

use axum::{Json, extract::State};
use axum_extra::extract::CookieJar;
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::core::{ApiError, AppState};
use access::{Permission, Role, staff_member};

mod access;
mod icons;
mod images;
mod orders;
mod push;
mod revenue;
mod routes;
mod service_listings;
mod service_prices;
mod staff;
mod stock;
pub(crate) use routes::{DashboardApi, routes};

#[cfg(test)]
mod tests;

#[cfg(all(test, feature = "database-tests"))]
mod database_tests;

#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardAccount {
    pub id: Uuid,
    pub username: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardSession {
    /// What the role may open, so the page can hide a link the API would refuse.
    pub permissions: Vec<Permission>,
    pub role: Role,
    pub user: DashboardAccount,
}

#[utoipa::path(
    get,
    path = "/dashboard/session",
    responses(
        (status = 200, description = "The signed-in member of staff and what the role may do", body = DashboardSession),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The account is not a member of staff, or its access is switched off", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn dashboard_session(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<DashboardSession>, ApiError> {
    let user = staff_member(&state, &jar).await?;

    Ok(Json(DashboardSession {
        permissions: user.role.permissions().to_vec(),
        role: user.role,
        user: DashboardAccount {
            id: user.id,
            username: user.username,
        },
    }))
}

fn database_error(error: sqlx::Error) -> ApiError {
    crate::utils::database_error("dashboard", error)
}
