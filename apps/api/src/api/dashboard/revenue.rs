//! What the shop has taken, by day, by product and by who settled it. Days are
//! shop days (UTC+7), so a sale at 01:00 belongs to the day the shop had.

use axum::{
    Json,
    extract::{Query, State},
};
use axum_extra::extract::CookieJar;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::core::{ApiError, AppState};

use super::{
    access::{Permission, authorize},
    database_error,
};

const SHOP_TIME_ZONE: &str = "Asia/Ho_Chi_Minh";
const PERIODS: [i32; 3] = [7, 14, 30];
const TOP_ITEMS: i64 = 5;

#[derive(Debug, Deserialize, IntoParams)]
pub struct RevenueQuery {
    /// The length of the period shown: 7, 14 or 30 days (7 when left out).
    pub days: Option<i32>,
}

#[derive(Debug, Serialize, ToSchema, sqlx::FromRow)]
pub struct RevenueDay {
    pub date: NaiveDate,
    pub orders: i64,
    pub total_vnd: i64,
}

#[derive(Debug, Serialize, ToSchema, sqlx::FromRow)]
pub struct RevenueItem {
    pub orders: i64,
    pub title: String,
    pub total_vnd: i64,
}

#[derive(Debug, Serialize, ToSchema, sqlx::FromRow)]
pub struct RevenueSeller {
    pub orders: i64,
    /// The username of the member of staff, or empty for what SePay settled.
    pub seller: Option<String>,
    pub total_vnd: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardRevenue {
    /// Every day of the period and of the one before it, oldest first, with the
    /// days that took nothing present as zero. That is `2 * days` entries, so the
    /// page can set a period against the one before.
    pub daily: Vec<RevenueDay>,
    pub days: i32,
    /// By how many orders, over the period shown.
    pub top_items: Vec<RevenueItem>,
    /// By what they came to, over the period shown.
    pub by_seller: Vec<RevenueSeller>,
}

#[utoipa::path(
    get,
    path = "/dashboard/telegram/revenue",
    params(RevenueQuery),
    responses(
        (status = 200, description = "Takings by day, best sellers and sellers, in đồng", body = DashboardRevenue),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not see the revenue", body = crate::core::ErrorResponse),
        (status = 422, description = "The period is not 7, 14 or 30 days", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn revenue(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<RevenueQuery>,
) -> Result<Json<DashboardRevenue>, ApiError> {
    authorize(&state, &jar, Permission::Revenue).await?;

    let days = query.days.unwrap_or(7);
    if !PERIODS.contains(&days) {
        return Err(ApiError::Validation("A period is 7, 14 or 30 days."));
    }

    // Today, as the shop has it, and the first day of the period shown.
    let today = format!("(NOW() AT TIME ZONE '{SHOP_TIME_ZONE}')::date");
    let period_start =
        format!("(({today} - ($1::int - 1))::timestamp AT TIME ZONE '{SHOP_TIME_ZONE}')");

    let daily = sqlx::query_as::<_, RevenueDay>(&format!(
        "SELECT day::date AS date,
                COUNT(o.id)::BIGINT AS orders,
                COALESCE(SUM(o.total_vnd), 0)::BIGINT AS total_vnd
         FROM generate_series({today} - ($1::int * 2 - 1), {today}, INTERVAL '1 day') AS day
         LEFT JOIN telegram_orders AS o
                ON o.status = 'paid'
               AND (o.paid_at AT TIME ZONE '{SHOP_TIME_ZONE}')::date = day::date
         GROUP BY day
         ORDER BY day"
    ))
    .bind(days)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    let top_items = sqlx::query_as::<_, RevenueItem>(&format!(
        "SELECT o.item_title AS title,
                COUNT(*)::BIGINT AS orders,
                SUM(o.total_vnd)::BIGINT AS total_vnd
         FROM telegram_orders AS o
         WHERE o.status = 'paid' AND o.paid_at >= {period_start}
         GROUP BY o.item_title
         ORDER BY orders DESC, total_vnd DESC, title
         LIMIT {TOP_ITEMS}"
    ))
    .bind(days)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    let by_seller = sqlx::query_as::<_, RevenueSeller>(&format!(
        "SELECT handler.username AS seller,
                COUNT(*)::BIGINT AS orders,
                SUM(o.total_vnd)::BIGINT AS total_vnd
         FROM telegram_orders AS o
         LEFT JOIN users AS handler ON handler.id = o.handled_by
         WHERE o.status = 'paid' AND o.paid_at >= {period_start}
         GROUP BY handler.username
         ORDER BY total_vnd DESC, seller"
    ))
    .bind(days)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    Ok(Json(DashboardRevenue {
        daily,
        days,
        top_items,
        by_seller,
    }))
}
