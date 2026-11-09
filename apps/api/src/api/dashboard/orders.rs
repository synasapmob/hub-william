//! Orders the bot's buyers placed, as the shop's staff work through them: the
//! queue of those awaiting payment, marking one paid by hand or cancelling it,
//! and the history of what was sold. The rows are `telegram_orders`, the ones the
//! bot writes; the dashboard only adds who settled an order and how it was paid.

use axum::{
    Json,
    extract::{Path, Query, State},
};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    api::telegram::{ORDER_COLUMNS, TelegramOrder, accounts::use_up_stock},
    core::{ApiError, AppState},
};

use super::{
    access::{Permission, authorize},
    database_error,
    push::call_adapter,
};

const DEFAULT_PAGE_SIZE: i64 = 20;
const MAXIMUM_PAGE_SIZE: i64 = 100;
const SHOP_TIME_ZONE: &str = "Asia/Ho_Chi_Minh";

/// How an order was paid. SePay settles a bank transfer by itself; the rest is
/// something a member of staff saw and recorded.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentMethod {
    BankTransfer,
    Usdt,
    Cash,
}

impl PaymentMethod {
    const fn as_column(self) -> &'static str {
        match self {
            Self::BankTransfer => "bank_transfer",
            Self::Usdt => "usdt",
            Self::Cash => "cash",
        }
    }
}

#[derive(Debug, Serialize, ToSchema, sqlx::FromRow)]
pub struct DashboardOrder {
    pub created_at: DateTime<Utc>,
    /// The buyer's Telegram name, when they have one.
    pub customer_username: Option<String>,
    pub customer_first_name: String,
    /// Past this the order no longer holds stock, but it can still be paid.
    pub expires_at: DateTime<Utc>,
    /// The username of the member of staff who marked it paid or cancelled it.
    /// Empty for an order SePay settled, and one the buyer cancelled.
    pub handled_by: Option<String>,
    pub item_title: String,
    pub paid_at: Option<DateTime<Utc>>,
    /// `bank_transfer`, `usdt` or `cash`; set once the order is paid.
    pub payment_method: Option<String>,
    pub quantity: i32,
    pub reference: String,
    /// `awaiting_payment`, `paid` or `cancelled`.
    pub status: String,
    pub total_vnd: i64,
    pub unit_price_vnd: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OrderCounts {
    pub all: i64,
    pub awaiting_payment: i64,
    pub cancelled: i64,
    pub paid: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardOrders {
    /// How many orders each status has under the search, whatever status is shown.
    pub counts: OrderCounts,
    pub orders: Vec<DashboardOrder>,
    /// How many orders the status and the search match, across every page.
    pub total: i64,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct OrdersQuery {
    /// Only orders in this status: `awaiting_payment`, `paid` or `cancelled`.
    pub status: Option<String>,
    /// Matches the reference, the buyer's name and username, and the item.
    pub q: Option<String>,
    /// Counted from 1.
    pub page: Option<i64>,
    /// 1 to 100; 20 when left out.
    pub page_size: Option<i64>,
}

const ORDER_SELECT: &str = "SELECT o.created_at, c.username AS customer_username,
        c.first_name AS customer_first_name, o.expires_at, handler.username AS handled_by,
        o.item_title, o.paid_at, o.payment_method, o.quantity, o.reference, o.status,
        o.total_vnd, o.unit_price_vnd
    FROM telegram_orders AS o
    JOIN telegram_contacts AS c ON c.telegram_user_id = o.telegram_user_id
    LEFT JOIN users AS handler ON handler.id = o.handled_by";

/// The search, as a condition on the placeholder `$n`.
fn search_condition(n: usize) -> String {
    format!(
        "(${n}::text IS NULL OR o.reference ILIKE ${n} OR c.username ILIKE ${n}
          OR c.first_name ILIKE ${n} OR o.item_title ILIKE ${n})"
    )
}

/// What a person typed, as a pattern that finds it anywhere: `%` and `_` they
/// typed mean themselves, not "anything".
fn search_pattern(query: Option<String>) -> Option<String> {
    let query = query?;
    let query = query.trim();

    (!query.is_empty()).then(|| {
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");

        format!("%{escaped}%")
    })
}

pub(super) fn page_bounds(
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<(i64, i64), ApiError> {
    let page = page.unwrap_or(1);
    let page_size = page_size.unwrap_or(DEFAULT_PAGE_SIZE);

    if page < 1 || !(1..=MAXIMUM_PAGE_SIZE).contains(&page_size) {
        return Err(ApiError::Validation(
            "A page counts from 1, and holds 1 to 100 rows.",
        ));
    }

    Ok((page_size, (page - 1).saturating_mul(page_size)))
}

fn known_status(status: Option<&str>) -> Result<Option<&str>, ApiError> {
    match status {
        None | Some("awaiting_payment" | "paid" | "cancelled") => Ok(status),
        Some(_) => Err(ApiError::Validation(
            "An order status is awaiting_payment, paid or cancelled.",
        )),
    }
}

#[utoipa::path(
    get,
    path = "/dashboard/telegram/orders",
    params(OrdersQuery),
    responses(
        (status = 200, description = "A page of orders, and how many each status has", body = DashboardOrders),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not work with orders", body = crate::core::ErrorResponse),
        (status = 422, description = "The status or the page is not valid", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn list_orders(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<OrdersQuery>,
) -> Result<Json<DashboardOrders>, ApiError> {
    authorize(&state, &jar, Permission::Orders).await?;

    let status = known_status(query.status.as_deref())?.map(str::to_owned);
    let (limit, offset) = page_bounds(query.page, query.page_size)?;
    let pattern = search_pattern(query.q);

    // The queue is first come, first served; everything else shows the newest.
    let direction = if status.as_deref() == Some("awaiting_payment") {
        "ASC"
    } else {
        "DESC"
    };
    let orders = sqlx::query_as::<_, DashboardOrder>(&format!(
        "{ORDER_SELECT}
         WHERE ($1::text IS NULL OR o.status = $1) AND {}
         ORDER BY o.created_at {direction}, o.reference
         LIMIT $3 OFFSET $4",
        search_condition(2)
    ))
    .bind(&status)
    .bind(&pattern)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    let by_status = sqlx::query_as::<_, (String, i64)>(&format!(
        "SELECT o.status, COUNT(*)
         FROM telegram_orders AS o
         JOIN telegram_contacts AS c ON c.telegram_user_id = o.telegram_user_id
         WHERE {}
         GROUP BY o.status",
        search_condition(1)
    ))
    .bind(&pattern)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    let count_of = |wanted: &str| {
        by_status
            .iter()
            .find(|(name, _)| name == wanted)
            .map_or(0, |(_, count)| *count)
    };
    let counts = OrderCounts {
        all: by_status.iter().map(|(_, count)| count).sum(),
        awaiting_payment: count_of("awaiting_payment"),
        cancelled: count_of("cancelled"),
        paid: count_of("paid"),
    };
    let total = match status.as_deref() {
        Some("awaiting_payment") => counts.awaiting_payment,
        Some("paid") => counts.paid,
        Some("cancelled") => counts.cancelled,
        _ => counts.all,
    };

    Ok(Json(DashboardOrders {
        counts,
        orders,
        total,
    }))
}

async fn load_order(state: &AppState, reference: &str) -> Result<DashboardOrder, ApiError> {
    sqlx::query_as::<_, DashboardOrder>(&format!("{ORDER_SELECT} WHERE o.reference = $1"))
        .bind(reference)
        .fetch_optional(&state.pool)
        .await
        .map_err(database_error)?
        .ok_or(ApiError::NotFound)
}

/// A reference is 1 to 12 uppercase letters and digits, however it was typed.
fn normalize_reference(reference: &str) -> Result<String, ApiError> {
    let reference = reference.trim().to_ascii_uppercase();

    (!reference.is_empty()
        && reference.len() <= 12
        && reference
            .chars()
            .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit()))
    .then_some(reference)
    .ok_or(ApiError::Validation(
        "An order reference is 1-12 uppercase letters or digits.",
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PayOrder {
    /// How the money reached the shop.
    pub payment_method: PaymentMethod,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SettledOrder {
    /// Whether the bot told the buyer. The order is paid either way.
    pub notified: bool,
    pub order: DashboardOrder,
}

#[utoipa::path(
    post,
    path = "/dashboard/telegram/orders/{reference}/pay",
    params(("reference" = String, Path, description = "The order")),
    request_body = PayOrder,
    responses(
        (status = 200, description = "The order is paid, its stock is taken, and the buyer is told when the bot can", body = SettledOrder),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not work with orders", body = crate::core::ErrorResponse),
        (status = 404, description = "No such order", body = crate::core::ErrorResponse),
        (status = 422, description = "The order is not waiting for payment", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn pay_order(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(reference): Path<String>,
    Json(body): Json<PayOrder>,
) -> Result<Json<SettledOrder>, ApiError> {
    let user = authorize(&state, &jar, Permission::Orders).await?;
    let reference = normalize_reference(&reference)?;

    let mut database = state.pool.begin().await.map_err(database_error)?;

    // An order past its time can still be paid: it only stopped holding stock.
    let settled = sqlx::query_as::<_, TelegramOrder>(&format!(
        "UPDATE telegram_orders
         SET status = 'paid', paid_at = NOW(), payment_method = $2, handled_by = $3
         WHERE reference = $1 AND status = 'awaiting_payment'
         RETURNING {ORDER_COLUMNS}"
    ))
    .bind(&reference)
    .bind(body.payment_method.as_column())
    .bind(user.id)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;

    let Some(settled) = settled else {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM telegram_orders WHERE reference = $1)",
        )
        .bind(&reference)
        .fetch_one(&mut *database)
        .await
        .map_err(database_error)?;

        return Err(if exists {
            ApiError::Validation("That order is not waiting for payment.")
        } else {
            ApiError::NotFound
        });
    };

    // A paid order stops holding stock and starts using it up, and hands out its
    // accounts, exactly as when SePay settles one.
    use_up_stock(
        &mut database,
        &settled.item_id,
        &settled.reference,
        settled.quantity,
    )
    .await?;

    database.commit().await.map_err(database_error)?;

    // The money is in and recorded; whether the buyer hears about it is a
    // courtesy, so a bot that is down does not undo the payment.
    let notified = match call_adapter(&state, "/internal/payment-notice", &settled).await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    };

    Ok(Json(SettledOrder {
        notified,
        order: load_order(&state, &reference).await?,
    }))
}

#[utoipa::path(
    post,
    path = "/dashboard/telegram/orders/{reference}/cancel",
    params(("reference" = String, Path, description = "The order")),
    responses(
        (status = 200, description = "The order is cancelled and stops holding stock", body = DashboardOrder),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not work with orders", body = crate::core::ErrorResponse),
        (status = 404, description = "No such order", body = crate::core::ErrorResponse),
        (status = 422, description = "The order is not waiting for payment", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn cancel_order(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(reference): Path<String>,
) -> Result<Json<DashboardOrder>, ApiError> {
    let user = authorize(&state, &jar, Permission::Orders).await?;
    let reference = normalize_reference(&reference)?;

    // Cancelling only stops the order from being matched later; a transfer that
    // already arrived stays recorded against it.
    let cancelled = sqlx::query_scalar::<_, Uuid>(
        "UPDATE telegram_orders
         SET status = 'cancelled', handled_by = $2
         WHERE reference = $1 AND status = 'awaiting_payment'
         RETURNING id",
    )
    .bind(&reference)
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?;

    if cancelled.is_none() {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM telegram_orders WHERE reference = $1)",
        )
        .bind(&reference)
        .fetch_one(&state.pool)
        .await
        .map_err(database_error)?;

        return Err(if exists {
            ApiError::Validation("That order is not waiting for payment.")
        } else {
            ApiError::NotFound
        });
    }

    Ok(Json(load_order(&state, &reference).await?))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct SalesQuery {
    /// The first day to include, in shop time (`YYYY-MM-DD`).
    pub from: Option<NaiveDate>,
    /// The last day to include, in shop time.
    pub to: Option<NaiveDate>,
    /// A staff member's username, or `bot` for what SePay settled by itself.
    pub handled_by: Option<String>,
    /// Matches the reference, the buyer's name and username, and the item.
    pub q: Option<String>,
    /// Counted from 1.
    pub page: Option<i64>,
    /// 1 to 100; 20 when left out.
    pub page_size: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardSales {
    /// The newest first.
    pub orders: Vec<DashboardOrder>,
    /// Every member of staff who has marked an order paid, by username, so the
    /// history can be narrowed to one of them. It does not depend on the filters.
    pub sellers: Vec<String>,
    /// How many paid orders match, across every page.
    pub total: i64,
    /// What they come to, in đồng, across every page.
    pub total_vnd: i64,
}

/// The conditions of the history, over the placeholders `$1` (from), `$2` (to),
/// `$3` (who) and `$4` (the search).
fn sales_conditions() -> String {
    format!(
        "o.status = 'paid'
         AND ($1::date IS NULL OR o.paid_at >= ($1::date)::timestamp AT TIME ZONE '{SHOP_TIME_ZONE}')
         AND ($2::date IS NULL OR o.paid_at < (($2::date + 1)::timestamp AT TIME ZONE '{SHOP_TIME_ZONE}'))
         AND ($3::text IS NULL OR ($3 = 'bot' AND o.handled_by IS NULL) OR handler.username = $3)
         AND {}",
        search_condition(4)
    )
}

#[utoipa::path(
    get,
    path = "/dashboard/telegram/sales",
    params(SalesQuery),
    responses(
        (status = 200, description = "Paid orders in a range of days, newest first, and what they come to", body = DashboardSales),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not see the history", body = crate::core::ErrorResponse),
        (status = 422, description = "The range or the page is not valid", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn list_sales(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<SalesQuery>,
) -> Result<Json<DashboardSales>, ApiError> {
    authorize(&state, &jar, Permission::History).await?;

    let (limit, offset) = page_bounds(query.page, query.page_size)?;
    if let (Some(from), Some(to)) = (query.from, query.to)
        && from > to
    {
        return Err(ApiError::Validation("A range cannot end before it starts."));
    }
    let handled_by = query
        .handled_by
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty());
    let pattern = search_pattern(query.q);
    let conditions = sales_conditions();

    let orders = sqlx::query_as::<_, DashboardOrder>(&format!(
        "{ORDER_SELECT}
         WHERE {conditions}
         ORDER BY o.paid_at DESC, o.reference
         LIMIT $5 OFFSET $6"
    ))
    .bind(query.from)
    .bind(query.to)
    .bind(&handled_by)
    .bind(&pattern)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    let (total, total_vnd) = sqlx::query_as::<_, (i64, i64)>(&format!(
        "SELECT COUNT(*), COALESCE(SUM(o.total_vnd), 0)::BIGINT
         FROM telegram_orders AS o
         JOIN telegram_contacts AS c ON c.telegram_user_id = o.telegram_user_id
         LEFT JOIN users AS handler ON handler.id = o.handled_by
         WHERE {conditions}"
    ))
    .bind(query.from)
    .bind(query.to)
    .bind(&handled_by)
    .bind(&pattern)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;

    let sellers = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT handler.username
         FROM telegram_orders AS o
         JOIN users AS handler ON handler.id = o.handled_by
         WHERE o.status = 'paid'
         ORDER BY handler.username",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    Ok(Json(DashboardSales {
        orders,
        sellers,
        total,
        total_vnd,
    }))
}

#[cfg(test)]
mod tests {
    use super::{normalize_reference, page_bounds, search_pattern};

    #[test]
    fn a_search_finds_what_was_typed_anywhere_and_literally() {
        assert_eq!(
            search_pattern(Some("  lan ".to_owned())),
            Some("%lan%".to_owned())
        );
        assert_eq!(
            search_pattern(Some("100%_off\\".to_owned())),
            Some("%100\\%\\_off\\\\%".to_owned())
        );
        assert_eq!(search_pattern(Some("   ".to_owned())), None);
        assert_eq!(search_pattern(None), None);
    }

    #[test]
    fn a_page_counts_from_one_and_holds_one_to_a_hundred_rows() {
        assert_eq!(page_bounds(None, None).unwrap(), (20, 0));
        assert_eq!(page_bounds(Some(3), Some(50)).unwrap(), (50, 100));
        assert!(page_bounds(Some(0), None).is_err());
        assert!(page_bounds(Some(-1), None).is_err());
        assert!(page_bounds(None, Some(0)).is_err());
        assert!(page_bounds(None, Some(101)).is_err());
        // A huge page does not overflow; it is just past the end.
        assert!(page_bounds(Some(i64::MAX), Some(100)).is_ok());
    }

    #[test]
    fn a_reference_is_upper_cased_and_bounded() {
        assert_eq!(normalize_reference(" ab12cd ").unwrap(), "AB12CD");
        assert!(normalize_reference("").is_err());
        assert!(normalize_reference("ABCDEFGHIJKLM").is_err());
        assert!(normalize_reference("AB-12").is_err());
    }
}
