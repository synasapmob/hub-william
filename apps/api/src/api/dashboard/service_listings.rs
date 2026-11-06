//! Hub William's own stock: the agent accounts the staff put on sale as tickets.
//! A member of the staff connects an account of their own (on the Agents page, or
//! from the dashboard, which asks the same endpoints), has it verified here, and
//! puts it on sale for a number of days at a price. It is sold once, to whoever buys
//! it first (see `api::service::listings`), and then it is history.

use std::str::FromStr;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    api::{
        agent::usage,
        gateway::probe_connection,
        service::{QuotaMetric, quota_from_json},
    },
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

use super::{
    access::{Permission, authorize},
    database_error,
};

/// The agents the Service sells, in the order its Pricing page shows them.
const PROVIDERS: [&str; 6] = ["chatgpt", "gemini", "claude", "deepseek", "grok", "groq"];

const MIN_PRICE_MICRO: i64 = 10_000;
const MAX_PRICE_MICRO: i64 = 10_000_000_000;
const MAX_DAYS: i32 = 365;
const MAX_NAME: usize = 80;

/// A ticket that has not been sold: for sale, or kept off sale until its owner fixes it.
#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardListing {
    pub id: Uuid,
    pub provider: String,
    pub name: String,
    /// How long the key lasts once it is bought.
    pub days: i32,
    pub price_micro: i64,
    /// Whether it is switched on for sale.
    pub listed: bool,
    /// `for_sale`, `hidden` (switched off), `needs_reconnect` (its owner has to
    /// connect the account again) or `disconnected` (the account is gone).
    pub status: String,
    /// What the account had left when it was verified; empty when the provider does
    /// not say.
    pub quota: Vec<QuotaMetric>,
    pub quota_captured_at: Option<DateTime<Utc>>,
    pub account_label: Option<String>,
    pub plan: Option<String>,
    /// The username of the member of staff who put it on sale.
    pub seller: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardListings {
    pub listings: Vec<DashboardListing>,
}

#[derive(FromRow)]
struct ListingRow {
    id: Uuid,
    provider: String,
    name: String,
    days: i32,
    price_micro: i64,
    listed: bool,
    status: String,
    quota: String,
    quota_captured_at: Option<DateTime<Utc>>,
    account_label: Option<String>,
    plan: Option<String>,
    seller: Option<String>,
    created_at: DateTime<Utc>,
}

async fn listings(state: &AppState, only: Option<Uuid>) -> Result<Vec<DashboardListing>, ApiError> {
    let rows = sqlx::query_as::<_, ListingRow>(
        "SELECT listings.id, listings.provider, listings.name, listings.days,
                listings.price_micro, listings.listed,
                CASE WHEN connections.id IS NULL OR connections.status <> 'connected'
                          THEN 'disconnected'
                     WHEN connections.availability_status = 'reauth_required'
                          THEN 'needs_reconnect'
                     WHEN NOT listings.listed THEN 'hidden'
                     ELSE 'for_sale' END AS status,
                listings.quota::text AS quota, listings.quota_captured_at,
                connections.account_label, connections.plan,
                sellers.username AS seller, listings.created_at
         FROM service_listings AS listings
         LEFT JOIN agent_connections AS connections ON connections.id = listings.connection_id
         LEFT JOIN users AS sellers ON sellers.id = listings.seller_id
         WHERE listings.sold_at IS NULL AND ($2::uuid IS NULL OR listings.id = $2)
         ORDER BY array_position($1::text[], listings.provider), listings.created_at, listings.id",
    )
    .bind(PROVIDERS.map(str::to_owned).to_vec())
    .bind(only)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    Ok(rows
        .into_iter()
        .map(|row| DashboardListing {
            account_label: row.account_label,
            created_at: row.created_at,
            days: row.days,
            id: row.id,
            listed: row.listed,
            name: row.name,
            plan: row.plan,
            price_micro: row.price_micro,
            provider: row.provider,
            quota: quota_from_json(&row.quota),
            quota_captured_at: row.quota_captured_at,
            seller: row.seller,
            status: row.status,
        })
        .collect())
}

#[utoipa::path(
    get,
    path = "/dashboard/service/listings",
    responses(
        (status = 200, description = "The tickets that are not sold yet", body = DashboardListings),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn list_service_listings(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<DashboardListings>, ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;

    Ok(Json(DashboardListings {
        listings: listings(&state, None).await?,
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct VerifyAccount {
    /// An account the signed-in member connected, on the Agents page or from here.
    pub connection_id: Uuid,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct VerifiedAccount {
    pub provider: String,
    pub account_label: Option<String>,
    pub plan: Option<String>,
    /// What the account has left, as the provider says; empty when it does not.
    pub quota: Vec<QuotaMetric>,
    pub captured_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct AccountRow {
    provider: String,
    status: String,
    account_label: Option<String>,
    plan: Option<String>,
}

/// Checks an account of the signed-in member for sale: it is theirs, it is connected,
/// the provider answers a test request through it, and what it has left is read.
async fn verify(
    state: &AppState,
    member: Uuid,
    connection_id: Uuid,
) -> Result<VerifiedAccount, ApiError> {
    let account = sqlx::query_as::<_, AccountRow>(
        "SELECT provider, status, account_label, plan
         FROM agent_connections WHERE id = $1 AND user_id = $2",
    )
    .bind(connection_id)
    .bind(member)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::Validation(
        "That account is not one you connected yourself.",
    ))?;

    if account.status != "connected" {
        return Err(ApiError::Validation("That account is not connected yet."));
    }

    let provider = AgentProvider::from_str(&account.provider)?;

    probe_connection(state, member, connection_id, provider).await?;

    // What the account has left, when the provider says. A provider that does not, or
    // that did not answer in time, leaves the list empty: that is not a refusal.
    let quota = usage::for_connection(state, connection_id, provider)
        .await
        .metrics
        .into_iter()
        .filter(|metric| metric.value != "Unavailable")
        .map(|metric| QuotaMetric {
            detail: metric.detail,
            label: metric.label,
            value: metric.value,
        })
        .collect();

    Ok(VerifiedAccount {
        account_label: account.account_label,
        captured_at: Utc::now(),
        plan: account.plan,
        provider: account.provider,
        quota,
    })
}

#[utoipa::path(
    post,
    path = "/dashboard/service/verify",
    request_body = VerifyAccount,
    responses(
        (status = 200, description = "The account answered a test request; what it has left, when the provider says", body = VerifiedAccount),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 422, description = "Not an account the member connected, or not connected yet", body = crate::core::ErrorResponse),
        (status = 502, description = "The provider did not answer a test request through the account", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn verify_service_account(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<VerifyAccount>,
) -> Result<Json<VerifiedAccount>, ApiError> {
    let by = authorize(&state, &jar, Permission::Stock).await?;

    Ok(Json(verify(&state, by.id, body.connection_id).await?))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateListing {
    /// The account that is sold, verified again as the ticket is made.
    pub connection_id: Uuid,
    pub name: String,
    /// How long the key lasts once it is bought, 1 to 365.
    pub days: i32,
    /// In micro-dollars, whole cents, $0.01 to $10,000.
    pub price_micro: i64,
}

fn valid_terms(name: &str, days: i32, price_micro: i64) -> Result<String, ApiError> {
    let name = name.trim();

    if name.is_empty() || name.chars().count() > MAX_NAME {
        return Err(ApiError::Validation("The name must be 1 to 80 characters."));
    }
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(ApiError::Validation("The days must be 1 to 365."));
    }
    if !(MIN_PRICE_MICRO..=MAX_PRICE_MICRO).contains(&price_micro) || price_micro % 10_000 != 0 {
        return Err(ApiError::Validation(
            "The price must be whole cents, from $0.01 to $10,000.",
        ));
    }

    Ok(name.to_owned())
}

#[utoipa::path(
    post,
    path = "/dashboard/service/listings",
    request_body = CreateListing,
    responses(
        (status = 201, description = "The ticket is on sale", body = DashboardListing),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 409, description = "The account is on sale already, or sold to a customer whose ticket has not ended", body = crate::core::ErrorResponse),
        (status = 422, description = "The terms are not valid, or the account is not one the member connected", body = crate::core::ErrorResponse),
        (status = 502, description = "The provider did not answer a test request through the account", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn create_service_listing(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<CreateListing>,
) -> Result<(StatusCode, Json<DashboardListing>), ApiError> {
    let by = authorize(&state, &jar, Permission::Stock).await?;
    let name = valid_terms(&body.name, body.days, body.price_micro)?;

    // An account is sold to one customer at a time: not while it is on sale, and not
    // while the key of a customer who bought it still works.
    let held = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (
            SELECT 1 FROM service_listings AS listings
            LEFT JOIN gateway_keys AS keys
              ON keys.listing_id = listings.id AND keys.revoked_at IS NULL AND keys.expires_at > NOW()
            WHERE listings.connection_id = $1
              AND (listings.sold_at IS NULL OR keys.id IS NOT NULL))",
    )
    .bind(body.connection_id)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;

    if held {
        return Err(ApiError::Exists(
            "That account is on sale already, or sold to a customer whose ticket has not ended.",
        ));
    }

    let account = verify(&state, by.id, body.connection_id).await?;
    let quota = serde_json::to_string(&account.quota).map_err(|_| ApiError::Internal)?;

    let id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO service_listings
            (id, provider, connection_id, seller_id, name, days, price_micro, quota,
             quota_captured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (connection_id) WHERE sold_at IS NULL AND connection_id IS NOT NULL
         DO NOTHING
         RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(&account.provider)
    .bind(body.connection_id)
    .bind(by.id)
    .bind(&name)
    .bind(body.days)
    .bind(body.price_micro)
    .bind(quota)
    .bind(account.captured_at)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::Exists(
        "That account is on sale already, or sold to a customer whose ticket has not ended.",
    ))?;

    let listing = listings(&state, Some(id))
        .await?
        .into_iter()
        .next()
        .ok_or(ApiError::NotFound)?;

    Ok((StatusCode::CREATED, Json(listing)))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateListing {
    pub name: String,
    pub days: i32,
    pub price_micro: i64,
    /// Whether it is switched on for sale.
    pub listed: bool,
}

#[utoipa::path(
    put,
    path = "/dashboard/service/listings/{id}",
    params(("id" = Uuid, Path, description = "The ticket")),
    request_body = UpdateListing,
    responses(
        (status = 200, description = "The ticket as it is now", body = DashboardListing),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 404, description = "No such ticket, or it is sold", body = crate::core::ErrorResponse),
        (status = 422, description = "The terms are not valid", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn update_service_listing(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateListing>,
) -> Result<Json<DashboardListing>, ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;
    let name = valid_terms(&body.name, body.days, body.price_micro)?;

    sqlx::query_scalar::<_, Uuid>(
        "UPDATE service_listings
         SET name = $2, days = $3, price_micro = $4, listed = $5, updated_at = NOW()
         WHERE id = $1 AND sold_at IS NULL
         RETURNING id",
    )
    .bind(id)
    .bind(name)
    .bind(body.days)
    .bind(body.price_micro)
    .bind(body.listed)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    listings(&state, Some(id))
        .await?
        .into_iter()
        .next()
        .map(Json)
        .ok_or(ApiError::NotFound)
}

#[utoipa::path(
    delete,
    path = "/dashboard/service/listings/{id}",
    params(("id" = Uuid, Path, description = "The ticket")),
    responses(
        (status = 204, description = "Taken off sale; the account itself is untouched"),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 404, description = "No such ticket, or it is sold", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn delete_service_listing(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;

    sqlx::query_scalar::<_, Uuid>(
        "DELETE FROM service_listings WHERE id = $1 AND sold_at IS NULL RETURNING id",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .map(|_| StatusCode::NO_CONTENT)
    .ok_or(ApiError::NotFound)
}

/// A ticket that was sold.
#[derive(Debug, Serialize, ToSchema, FromRow)]
pub struct DashboardTicketSale {
    pub id: Uuid,
    pub sold_at: DateTime<Utc>,
    pub provider: String,
    pub name: String,
    pub days: i32,
    /// What the customer paid, in micro-dollars.
    pub price_micro: i64,
    pub buyer: Option<String>,
    pub seller: Option<String>,
    /// The last four characters of the key the customer got.
    pub key_last_four: Option<String>,
    /// When that key stops working.
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardTicketSales {
    pub sales: Vec<DashboardTicketSale>,
}

#[utoipa::path(
    get,
    path = "/dashboard/service/sales",
    responses(
        (status = 200, description = "The tickets that were sold, newest first, the last 500", body = DashboardTicketSales),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not see the history", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn list_service_sales(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<DashboardTicketSales>, ApiError> {
    authorize(&state, &jar, Permission::History).await?;

    sqlx::query_as::<_, DashboardTicketSale>(
        "SELECT listings.id, listings.sold_at, listings.provider, listings.name, listings.days,
                listings.sold_price_micro AS price_micro, buyers.username AS buyer,
                sellers.username AS seller, keys.last_four AS key_last_four,
                keys.expires_at
         FROM service_listings AS listings
         LEFT JOIN users AS buyers ON buyers.id = listings.buyer_id
         LEFT JOIN users AS sellers ON sellers.id = listings.seller_id
         LEFT JOIN LATERAL (
             SELECT last_four, expires_at FROM gateway_keys
             WHERE listing_id = listings.id ORDER BY created_at DESC LIMIT 1
         ) AS keys ON TRUE
         WHERE listings.sold_at IS NOT NULL
         ORDER BY listings.sold_at DESC, listings.id
         LIMIT 500",
    )
    .fetch_all(&state.pool)
    .await
    .map(|sales| Json(DashboardTicketSales { sales }))
    .map_err(database_error)
}
