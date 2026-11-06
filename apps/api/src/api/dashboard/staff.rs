//! Who may use the dashboard. A member of staff is an ordinary Hub William
//! account with a role here, added by its username. An owner is a member like any
//! other, with the role `owner`, and may add and remove members, owners included.
//! The one rule is that the shop always has an active owner: the last one cannot be
//! demoted or removed. The first owner is made in the database (see the Dashboard
//! doc), since there is no one yet to make them.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::core::{ApiError, AppState};

use super::{
    access::{Permission, Role, authorize},
    database_error,
};

#[derive(Debug, Serialize, ToSchema)]
pub struct StaffMember {
    pub id: Uuid,
    /// When they last signed in, or last had their session refreshed.
    pub last_active_at: Option<DateTime<Utc>>,
    /// The last active owner, whose role cannot change and who cannot be removed,
    /// so the shop is never left without one.
    pub locked: bool,
    /// Orders they marked paid today, in shop time.
    pub orders_today: i64,
    /// What those orders come to, in đồng.
    pub revenue_today_vnd: i64,
    pub role: Role,
    pub username: String,
}

#[derive(sqlx::FromRow)]
struct StaffRow {
    id: Uuid,
    last_active_at: Option<DateTime<Utc>>,
    locked: bool,
    orders_today: i64,
    revenue_today_vnd: i64,
    role: String,
    username: String,
}

impl TryFrom<StaffRow> for StaffMember {
    type Error = ApiError;

    fn try_from(row: StaffRow) -> Result<Self, ApiError> {
        let role = Role::from_column(&row.role).ok_or_else(|| {
            eprintln!("dashboard staff row holds the unknown role {}", row.role);
            ApiError::Internal
        })?;

        Ok(Self {
            id: row.id,
            last_active_at: row.last_active_at,
            locked: row.locked,
            orders_today: row.orders_today,
            revenue_today_vnd: row.revenue_today_vnd,
            role,
            username: row.username,
        })
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct StaffList {
    pub members: Vec<StaffMember>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AddStaff {
    /// The username of an account that already exists.
    pub username: String,
    /// `owner`, `manager`, `cashier` or `stock-keeper`.
    pub role: Role,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ChangeRole {
    pub role: Role,
}

#[utoipa::path(
    get,
    path = "/dashboard/staff",
    responses(
        (status = 200, description = "Everyone who may use the dashboard, with what they did today", body = StaffList),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage staff", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn list_staff(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<StaffList>, ApiError> {
    authorize(&state, &jar, Permission::Staff).await?;

    Ok(Json(StaffList {
        members: all_members(&state).await?,
    }))
}

/// Everyone who may use the dashboard: the owners first, then the others by name.
async fn all_members(state: &AppState) -> Result<Vec<StaffMember>, ApiError> {
    let rows = sqlx::query_as::<_, StaffRow>(
        "SELECT users.id,
                (SELECT MAX(created_at) FROM sessions WHERE sessions.user_id = users.id) AS last_active_at,
                (staff.role = 'owner' AND NOT EXISTS (
                    SELECT 1 FROM dashboard_staff AS others
                    WHERE others.role = 'owner' AND others.active AND others.user_id <> users.id
                )) AS locked,
                COALESCE(today.orders, 0)::BIGINT AS orders_today,
                COALESCE(today.total, 0)::BIGINT AS revenue_today_vnd,
                staff.role AS role,
                users.username
         FROM dashboard_staff AS staff
         JOIN users ON users.id = staff.user_id
         LEFT JOIN LATERAL (
             SELECT COUNT(*) AS orders, SUM(total_vnd) AS total
             FROM telegram_orders
             WHERE handled_by = users.id
               AND status = 'paid'
               AND (paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
                   = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
         ) AS today ON TRUE
         WHERE staff.active
         ORDER BY (staff.role = 'owner') DESC, users.username",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    rows.into_iter().map(StaffMember::try_from).collect()
}

#[utoipa::path(
    post,
    path = "/dashboard/staff",
    request_body = AddStaff,
    responses(
        (status = 201, description = "The account is now staff", body = StaffMember),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage staff", body = crate::core::ErrorResponse),
        (status = 409, description = "The account is already staff", body = crate::core::ErrorResponse),
        (status = 422, description = "No account has that username", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn add_staff(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<AddStaff>,
) -> Result<(StatusCode, Json<StaffMember>), ApiError> {
    let by = authorize(&state, &jar, Permission::Staff).await?;
    let role = body.role;
    let username = body.username.trim().to_ascii_lowercase();

    let user_id = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE username = $1")
        .bind(&username)
        .fetch_optional(&state.pool)
        .await
        .map_err(database_error)?
        .ok_or(ApiError::Validation("No account has that username."))?;

    let added = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO dashboard_staff (user_id, role, created_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING user_id",
    )
    .bind(user_id)
    .bind(role.as_column())
    .bind(by.id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?;

    if added.is_none() {
        return Err(ApiError::Exists("That account is already staff."));
    }

    Ok((StatusCode::CREATED, Json(member(&state, user_id).await?)))
}

async fn member(state: &AppState, id: Uuid) -> Result<StaffMember, ApiError> {
    all_members(state)
        .await?
        .into_iter()
        .find(|member| member.id == id)
        .ok_or(ApiError::NotFound)
}

#[utoipa::path(
    put,
    path = "/dashboard/staff/{user_id}",
    params(("user_id" = Uuid, Path, description = "The member of staff")),
    request_body = ChangeRole,
    responses(
        (status = 200, description = "The member with the new role", body = StaffMember),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage staff", body = crate::core::ErrorResponse),
        (status = 404, description = "Not a member of staff", body = crate::core::ErrorResponse),
        (status = 422, description = "The last owner cannot be given another role", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn change_role(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(user_id): Path<Uuid>,
    Json(body): Json<ChangeRole>,
) -> Result<Json<StaffMember>, ApiError> {
    authorize(&state, &jar, Permission::Staff).await?;

    let mut transaction = state.pool.begin().await.map_err(database_error)?;

    // The owners are locked while this is decided, so two owners who demote each
    // other at the same moment cannot leave the shop with none.
    if body.role != Role::Owner {
        ensure_another_owner(&mut transaction, user_id).await?;
    }

    let changed = sqlx::query_scalar::<_, Uuid>(
        "UPDATE dashboard_staff SET role = $2 WHERE user_id = $1 AND active RETURNING user_id",
    )
    .bind(user_id)
    .bind(body.role.as_column())
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;

    if changed.is_none() {
        return Err(ApiError::NotFound);
    }

    transaction.commit().await.map_err(database_error)?;

    Ok(Json(member(&state, user_id).await?))
}

#[utoipa::path(
    delete,
    path = "/dashboard/staff/{user_id}",
    params(("user_id" = Uuid, Path, description = "The member of staff")),
    responses(
        (status = 204, description = "The account is no longer staff"),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage staff", body = crate::core::ErrorResponse),
        (status = 404, description = "Not a member of staff", body = crate::core::ErrorResponse),
        (status = 422, description = "Oneself, or the last owner, cannot be removed", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn remove_staff(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(user_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let by = authorize(&state, &jar, Permission::Staff).await?;

    if by.id == user_id {
        return Err(ApiError::Validation("You cannot remove yourself."));
    }

    let mut transaction = state.pool.begin().await.map_err(database_error)?;

    ensure_another_owner(&mut transaction, user_id).await?;

    let removed = sqlx::query_scalar::<_, Uuid>(
        "DELETE FROM dashboard_staff WHERE user_id = $1 RETURNING user_id",
    )
    .bind(user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;

    transaction.commit().await.map_err(database_error)?;

    removed
        .map(|_| StatusCode::NO_CONTENT)
        .ok_or(ApiError::NotFound)
}

/// Refuses when `user_id` is the only active owner, which is the one thing that is
/// never allowed to stop being true. The owners' rows are locked first, so the
/// answer is still true when the change is made.
async fn ensure_another_owner(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
) -> Result<(), ApiError> {
    let owners = sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM dashboard_staff WHERE role = 'owner' AND active FOR UPDATE",
    )
    .fetch_all(&mut **transaction)
    .await
    .map_err(database_error)?;

    if owners == [user_id] {
        return Err(ApiError::Validation(
            "The shop needs at least one owner: make another account an owner first.",
        ));
    }

    Ok(())
}
