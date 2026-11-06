//! Tickets. A member of the staff puts one of their own agent accounts on sale for
//! a number of days at a price (see `api::dashboard::service_listings`); a customer
//! who pays the price from the wallet gets a key that runs on that one account until
//! the days are up. The key is shown once, when it is bought; it can be replaced, but
//! never read again, since only its hash is kept.

use std::str::FromStr;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use super::{SERVICE_PROVIDERS, wallet};
use crate::{
    api::{
        auth::authenticated_user_id,
        gateway::{create_ticket_key, probe_connection},
    },
    core::{ApiError, AppState},
    utils::provider_catalogue::{AgentProvider, provider},
};

/// What a listing needs to be on sale now: not sold, switched on, and its account
/// still connected and not waiting for its owner to connect it again. It needs
/// `listings` and `connections` in scope.
const FOR_SALE: &str = "listings.sold_at IS NULL AND listings.listed
    AND connections.status = 'connected'
    AND connections.availability_status <> 'reauth_required'";

fn database_error(error: sqlx::Error) -> ApiError {
    crate::utils::database_error("service listings", error)
}

/// One line of what an account has left, as the provider reports it.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct QuotaMetric {
    pub label: String,
    pub value: String,
    pub detail: Option<String>,
}

/// What the quota column holds: a list of metrics, kept as JSON text.
pub(crate) fn quota_from_json(text: &str) -> Vec<QuotaMetric> {
    serde_json::from_str(text).unwrap_or_default()
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TicketListing {
    pub id: Uuid,
    pub name: String,
    /// How long the key lasts once it is bought.
    pub days: i32,
    /// In micro-dollars.
    pub price_micro: i64,
    /// What the account had left when it was put on sale; empty when the provider
    /// does not say.
    pub quota: Vec<QuotaMetric>,
    pub quota_captured_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TicketProvider {
    pub provider: String,
    pub label: String,
    pub listings: Vec<TicketListing>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TicketListings {
    /// Only the agents that have a ticket for sale, in the order of the Pricing page.
    pub providers: Vec<TicketProvider>,
}

#[derive(FromRow)]
struct ListingRow {
    id: Uuid,
    provider: String,
    name: String,
    days: i32,
    price_micro: i64,
    quota: String,
    quota_captured_at: Option<DateTime<Utc>>,
}

#[utoipa::path(
    get,
    path = "/service/listings",
    responses((status = 200, description = "The tickets for sale, by agent; an agent with none is left out", body = TicketListings)),
    tag = "service"
)]
pub async fn list_ticket_listings(
    State(state): State<AppState>,
) -> Result<Json<TicketListings>, ApiError> {
    let rows = sqlx::query_as::<_, ListingRow>(&format!(
        "SELECT listings.id, listings.provider, listings.name, listings.days,
                listings.price_micro, listings.quota::text AS quota, listings.quota_captured_at
         FROM service_listings AS listings
         JOIN agent_connections AS connections ON connections.id = listings.connection_id
         WHERE {FOR_SALE}
         ORDER BY array_position($1::text[], listings.provider), listings.created_at, listings.id"
    ))
    .bind(
        SERVICE_PROVIDERS
            .map(|agent| agent.as_str().to_owned())
            .to_vec(),
    )
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    let mut providers: Vec<TicketProvider> = Vec::new();

    for row in rows {
        let listing = TicketListing {
            days: row.days,
            id: row.id,
            name: row.name,
            price_micro: row.price_micro,
            quota: quota_from_json(&row.quota),
            quota_captured_at: row.quota_captured_at,
        };

        match providers.last_mut() {
            Some(last) if last.provider == row.provider => last.listings.push(listing),
            _ => providers.push(TicketProvider {
                label: AgentProvider::from_str(&row.provider)
                    .map(|agent| provider(agent).label.clone())
                    .unwrap_or_else(|_| row.provider.clone()),
                listings: vec![listing],
                provider: row.provider,
            }),
        }
    }

    Ok(Json(TicketListings { providers }))
}

/// A ticket's key, shown once, with what it is for.
#[derive(Debug, Serialize, ToSchema)]
pub struct PurchasedTicket {
    /// The key, which is never shown again.
    pub key: String,
    pub key_id: Uuid,
    pub last_four: String,
    pub expires_at: DateTime<Utc>,
    pub name: String,
    pub provider: String,
    pub days: i32,
    pub price_micro: i64,
}

#[derive(FromRow)]
struct SaleRow {
    seller_id: Option<Uuid>,
    connection_id: Uuid,
    provider: String,
    name: String,
    days: i32,
    price_micro: i64,
}

#[utoipa::path(
    post,
    path = "/service/listings/{id}/purchase",
    params(("id" = Uuid, Path, description = "The ticket")),
    responses(
        (status = 201, description = "Bought: the key, shown once", body = PurchasedTicket),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 402, description = "The wallet cannot cover the price", body = crate::core::ErrorResponse),
        (status = 404, description = "Not for sale, or sold just now", body = crate::core::ErrorResponse),
        (status = 422, description = "The ticket is the buyer's own", body = crate::core::ErrorResponse),
        (status = 502, description = "The account did not answer a test request, and nothing was charged", body = crate::core::ErrorResponse)
    ),
    tag = "service"
)]
pub async fn purchase_ticket(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<Uuid>,
) -> Result<(StatusCode, Json<PurchasedTicket>), ApiError> {
    let buyer = authenticated_user_id(&state, &jar).await?;

    let for_sale = sqlx::query_as::<_, SaleRow>(&format!(
        "SELECT listings.seller_id, connections.id AS connection_id, listings.provider,
                listings.name, listings.days, listings.price_micro
         FROM service_listings AS listings
         JOIN agent_connections AS connections ON connections.id = listings.connection_id
         WHERE listings.id = $1 AND {FOR_SALE}"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    if for_sale.seller_id == Some(buyer) {
        return Err(ApiError::Validation("You cannot buy your own ticket."));
    }

    // The account must answer before it is paid for, so a customer is not charged for
    // one that stopped working after it was put on sale. This is outside the
    // transaction, so a slow provider does not hold the listing.
    if let Some(seller) = for_sale.seller_id {
        probe_connection(
            &state,
            seller,
            for_sale.connection_id,
            AgentProvider::from_str(&for_sale.provider)?,
        )
        .await?;
    }

    let mut transaction = state.pool.begin().await.map_err(database_error)?;

    // The listing is locked, and found again as still for sale: of two customers who
    // press Buy together, one gets it and the other finds it gone.
    let still = sqlx::query_scalar::<_, Uuid>(&format!(
        "SELECT listings.id
         FROM service_listings AS listings
         JOIN agent_connections AS connections ON connections.id = listings.connection_id
         WHERE listings.id = $1 AND {FOR_SALE}
         FOR UPDATE OF listings"
    ))
    .bind(id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;

    if still.is_none() {
        return Err(ApiError::NotFound);
    }

    wallet::purchase(&mut transaction, buyer, id, for_sale.price_micro).await?;

    let expires_at = Utc::now() + Duration::days(i64::from(for_sale.days));
    let created = create_ticket_key(&mut transaction, buyer, id, expires_at).await?;

    sqlx::query(
        "UPDATE service_listings
         SET sold_at = NOW(), buyer_id = $2, sold_price_micro = $3, updated_at = NOW()
         WHERE id = $1",
    )
    .bind(id)
    .bind(buyer)
    .bind(for_sale.price_micro)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;

    transaction.commit().await.map_err(database_error)?;

    Ok((
        StatusCode::CREATED,
        Json(PurchasedTicket {
            days: for_sale.days,
            expires_at,
            key: created.key,
            key_id: created.metadata.id,
            last_four: created.metadata.last_four,
            name: for_sale.name,
            price_micro: for_sale.price_micro,
            provider: for_sale.provider,
        }),
    ))
}

/// A ticket the signed-in user bought, without its key.
#[derive(Debug, Serialize, ToSchema, FromRow)]
pub struct OwnedTicket {
    /// The key's id, for replacing it.
    pub key_id: Uuid,
    pub name: String,
    pub provider: String,
    pub days: i32,
    pub price_micro: i64,
    pub last_four: String,
    pub purchased_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    /// `active` or `expired`.
    pub status: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OwnedTickets {
    pub tickets: Vec<OwnedTicket>,
}

#[utoipa::path(
    get,
    path = "/service/tickets",
    responses(
        (status = 200, description = "The tickets the signed-in user bought, newest first", body = OwnedTickets),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse)
    ),
    tag = "service"
)]
pub async fn list_owned_tickets(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<OwnedTickets>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;

    sqlx::query_as::<_, OwnedTicket>(
        "SELECT keys.id AS key_id, listings.name, listings.provider, listings.days,
                listings.sold_price_micro AS price_micro, keys.last_four,
                listings.sold_at AS purchased_at, keys.expires_at,
                CASE WHEN keys.expires_at > NOW() THEN 'active' ELSE 'expired' END AS status
         FROM gateway_keys AS keys
         JOIN service_listings AS listings ON listings.id = keys.listing_id
         WHERE keys.user_id = $1 AND keys.kind = 'ticket' AND keys.revoked_at IS NULL
         ORDER BY listings.sold_at DESC, keys.id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map(|tickets| Json(OwnedTickets { tickets }))
    .map_err(database_error)
}

#[utoipa::path(
    post,
    path = "/service/tickets/{key_id}/reissue",
    params(("key_id" = Uuid, Path, description = "The key of the ticket")),
    responses(
        (status = 200, description = "A new key for the same ticket, shown once; the old one stops working", body = PurchasedTicket),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 404, description = "Not the user's ticket, or it has expired", body = crate::core::ErrorResponse)
    ),
    tag = "service"
)]
pub async fn reissue_ticket_key(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(key_id): Path<Uuid>,
) -> Result<Json<PurchasedTicket>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let mut transaction = state.pool.begin().await.map_err(database_error)?;

    // The key is only ever stored as a hash, so it cannot be shown again: the old one
    // is revoked and a new one made for the same ticket, with the same end.
    let held = sqlx::query_as::<_, (Uuid, DateTime<Utc>)>(
        "UPDATE gateway_keys SET revoked_at = NOW()
         WHERE id = $1 AND user_id = $2 AND kind = 'ticket'
           AND revoked_at IS NULL AND expires_at > NOW()
         RETURNING listing_id, expires_at",
    )
    .bind(key_id)
    .bind(user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;
    let created = create_ticket_key(&mut transaction, user_id, held.0, held.1).await?;
    let ticket = sqlx::query_as::<_, (String, String, i32, i64)>(
        "SELECT name, provider, days, sold_price_micro FROM service_listings WHERE id = $1",
    )
    .bind(held.0)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;

    transaction.commit().await.map_err(database_error)?;

    Ok(Json(PurchasedTicket {
        days: ticket.2,
        expires_at: held.1,
        key: created.key,
        key_id: created.metadata.id,
        last_four: created.metadata.last_four,
        name: ticket.0,
        price_micro: ticket.3,
        provider: ticket.1,
    }))
}
