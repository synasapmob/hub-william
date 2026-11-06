use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    api::auth::authenticated_user_id,
    core::{ApiError, AppState},
};

use super::database_error;

/// What a member of staff is, in the dashboard.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Owner,
    Manager,
    Cashier,
    StockKeeper,
}

/// What a page or an endpoint asks of a role.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Orders,
    History,
    Stock,
    Revenue,
    Staff,
}

impl Role {
    /// The one table of what each role may do. `apps/dashboard` keeps the same
    /// table to decide which links to show; the API is what actually refuses.
    pub const fn permissions(self) -> &'static [Permission] {
        match self {
            Self::Owner => &[
                Permission::Orders,
                Permission::History,
                Permission::Stock,
                Permission::Revenue,
                Permission::Staff,
            ],
            Self::Manager => &[
                Permission::Orders,
                Permission::History,
                Permission::Stock,
                Permission::Revenue,
            ],
            Self::Cashier => &[Permission::Orders, Permission::History],
            Self::StockKeeper => &[Permission::Stock],
        }
    }

    /// The text a role is stored as in `dashboard_staff.role`.
    pub const fn as_column(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Manager => "manager",
            Self::Cashier => "cashier",
            Self::StockKeeper => "stock-keeper",
        }
    }

    pub fn from_column(value: &str) -> Option<Self> {
        match value {
            "owner" => Some(Self::Owner),
            "manager" => Some(Self::Manager),
            "cashier" => Some(Self::Cashier),
            "stock-keeper" => Some(Self::StockKeeper),
            _ => None,
        }
    }
}

/// An account that may use the dashboard, and in which role.
#[derive(Clone, Debug)]
pub struct DashboardUser {
    pub id: Uuid,
    pub role: Role,
    pub username: String,
}

/// The signed-in account, if it is staff. No session is `Unauthorized`; an
/// account that is not staff, or whose access was switched off, is `Forbidden`.
pub async fn staff_member(state: &AppState, jar: &CookieJar) -> Result<DashboardUser, ApiError> {
    let id = authenticated_user_id(state, jar).await?;

    let (username, role, active) = sqlx::query_as::<_, (String, Option<String>, Option<bool>)>(
        "SELECT users.username, staff.role, staff.active
         FROM users
         LEFT JOIN dashboard_staff AS staff ON staff.user_id = users.id
         WHERE users.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::Unauthorized)?;

    // An owner is a row like any other member; there is no one the table does not
    // decide. A row that is switched off is no access at all.
    let role = if active == Some(true) {
        role.as_deref().and_then(Role::from_column)
    } else {
        None
    };

    Ok(DashboardUser {
        id,
        role: role.ok_or(ApiError::Forbidden)?,
        username,
    })
}

/// A member of staff whose role holds `permission`.
pub async fn authorize(
    state: &AppState,
    jar: &CookieJar,
    permission: Permission,
) -> Result<DashboardUser, ApiError> {
    let user = staff_member(state, jar).await?;

    user.role
        .permissions()
        .contains(&permission)
        .then_some(user)
        .ok_or(ApiError::Forbidden)
}
