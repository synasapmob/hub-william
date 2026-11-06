//! The wallet of one user, and the only code that changes it. Each movement is
//! one transaction that locks the user's row first, so two requests cannot spend
//! the same money, and it adds a row to `service_ledger`.

use std::collections::{HashMap, HashSet};

use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use super::model_ids;
use crate::{api::service::money::Price, core::ApiError};

fn database_error(error: sqlx::Error) -> ApiError {
    crate::utils::database_error("service wallet", error)
}

/// Every price the service has, so a price is found the same way wherever it is
/// needed: a model's own price, else its agent's, else the default.
pub(super) struct PriceBook {
    default: Price,
    providers: HashMap<String, Price>,
    models: HashMap<(String, String), Price>,
}

impl PriceBook {
    /// The price of a requested model, found under any id the price list knows it
    /// by, listed or not: a request that was served is charged what it cost.
    pub(super) fn price(&self, provider: &str, model: Option<&str>) -> Price {
        model
            .into_iter()
            .flat_map(model_ids)
            .find_map(|id| self.models.get(&(provider.to_owned(), id)).copied())
            .or_else(|| self.providers.get(provider).copied())
            .unwrap_or(self.default)
    }
}

fn price_of(row: (i64, i64, i64)) -> Price {
    Price {
        input: row.0,
        cached: row.1,
        output: row.2,
    }
}

pub(super) async fn price_book(pool: &PgPool) -> Result<PriceBook, ApiError> {
    let providers: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT provider, input_micro_per_million, cached_micro_per_million, output_micro_per_million
         FROM service_prices",
    )
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    let models: Vec<(String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT provider, model, input_micro_per_million, cached_micro_per_million,
                output_micro_per_million
         FROM service_model_prices",
    )
    .fetch_all(pool)
    .await
    .map_err(database_error)?;

    let mut providers: HashMap<String, Price> = providers
        .into_iter()
        .map(|(provider, input, cached, output)| (provider, price_of((input, cached, output))))
        .collect();
    let Some(default) = providers.remove("default") else {
        eprintln!("service prices have no default row");
        return Err(ApiError::Internal);
    };

    Ok(PriceBook {
        default,
        providers,
        models: models
            .into_iter()
            .map(|(provider, model, input, cached, output)| {
                ((provider, model), price_of((input, cached, output)))
            })
            .collect(),
    })
}

/// One model of the price list that is on sale.
pub(super) struct ListedPrice {
    pub(super) provider: String,
    pub(super) model: String,
    pub(super) name: String,
    pub(super) price: Price,
}

/// The models on sale, in the order the price list gives them.
pub(super) async fn listed_prices(pool: &PgPool) -> Result<Vec<ListedPrice>, ApiError> {
    let rows: Vec<(String, String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT provider, model, name, input_micro_per_million, cached_micro_per_million,
                output_micro_per_million
         FROM service_model_prices WHERE listed ORDER BY position, model",
    )
    .fetch_all(pool)
    .await
    .map_err(database_error)?;

    Ok(rows
        .into_iter()
        .map(
            |(provider, model, name, input, cached, output)| ListedPrice {
                provider,
                model,
                name,
                price: price_of((input, cached, output)),
            },
        )
        .collect())
}

/// The id the price list sells a requested model under, or none when the service
/// does not sell it: no row for it, or a row that is not listed.
pub(super) async fn sold_model(
    pool: &PgPool,
    provider: &str,
    requested: &str,
) -> Result<Option<String>, ApiError> {
    let ids = model_ids(requested);
    let sold: Vec<String> = sqlx::query_scalar(
        "SELECT model FROM service_model_prices
         WHERE provider = $1 AND listed AND model = ANY($2)",
    )
    .bind(provider)
    .bind(&ids)
    .fetch_all(pool)
    .await
    .map_err(database_error)?;

    Ok(ids.into_iter().find(|id| sold.contains(id)))
}

/// The providers the platform's stock has an account for that can serve a
/// request now: connected, in the stock, and not waiting for its owner to
/// reconnect it.
pub(super) async fn stocked_providers(pool: &PgPool) -> Result<HashSet<String>, ApiError> {
    let providers: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT provider FROM agent_connections
         WHERE service_stock AND status = 'connected'
           AND availability_status <> 'reauth_required'",
    )
    .fetch_all(pool)
    .await
    .map_err(database_error)?;

    Ok(providers.into_iter().collect())
}

/// What the user holds, in micro-dollars. A user who never used the service
/// holds nothing.
pub(super) async fn read(pool: &PgPool, user_id: Uuid) -> Result<i64, ApiError> {
    let wallet_micro: Option<i64> =
        sqlx::query_scalar("SELECT wallet_micro FROM service_wallets WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(database_error)?;

    Ok(wallet_micro.unwrap_or(0))
}

async fn lock(transaction: &mut Transaction<'_, Postgres>, user_id: Uuid) -> Result<i64, ApiError> {
    sqlx::query("INSERT INTO service_wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(user_id)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;

    sqlx::query_scalar("SELECT wallet_micro FROM service_wallets WHERE user_id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_one(&mut **transaction)
        .await
        .map_err(database_error)
}

async fn set_wallet(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    wallet_micro: i64,
) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE service_wallets SET wallet_micro = $2, updated_at = NOW() WHERE user_id = $1",
    )
    .bind(user_id)
    .bind(wallet_micro)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;

    Ok(())
}

/// Money paid in from outside lands in the wallet.
pub(super) async fn top_up(
    pool: &PgPool,
    user_id: Uuid,
    amount_micro: i64,
) -> Result<i64, ApiError> {
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let wallet_micro = lock(&mut transaction, user_id)
        .await?
        .checked_add(amount_micro)
        .ok_or(ApiError::Validation("The amount is out of range."))?;
    set_wallet(&mut transaction, user_id, wallet_micro).await?;
    sqlx::query(
        "INSERT INTO service_ledger (id, user_id, kind, amount_micro, wallet_after_micro)
         VALUES ($1, $2, 'top_up', $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(amount_micro)
    .bind(wallet_micro)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;

    Ok(wallet_micro)
}

/// How a payment that Stripe reported met the top-up it was for.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum TopUpOutcome {
    /// The wallet was credited now.
    Credited,
    /// The top-up was paid and credited before; nothing changed.
    AlreadyCredited,
    /// No top-up has that id.
    Unknown,
    /// The payment is not for what the top-up asked, or not for its customer.
    Mismatch,
}

/// Records that a customer is being sent to pay `amount_micro`, and returns the id
/// the payment will come back under.
pub(super) async fn begin_top_up(
    pool: &PgPool,
    user_id: Uuid,
    amount_micro: i64,
) -> Result<Uuid, ApiError> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO service_top_ups (id, user_id, amount_micro) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(user_id)
        .bind(amount_micro)
        .execute(pool)
        .await
        .map_err(database_error)?;

    Ok(id)
}

/// Remembers the Checkout Session Stripe opened for a top-up.
pub(super) async fn attach_session(
    pool: &PgPool,
    top_up_id: Uuid,
    session_id: &str,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE service_top_ups SET stripe_session_id = $2 WHERE id = $1")
        .bind(top_up_id)
        .bind(session_id)
        .execute(pool)
        .await
        .map_err(database_error)?;

    Ok(())
}

/// Closes a top-up that was never paid. One that was paid stays paid.
pub(super) async fn expire_top_up(pool: &PgPool, top_up_id: Uuid) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE service_top_ups SET status = 'expired' WHERE id = $1 AND status = 'pending'",
    )
    .bind(top_up_id)
    .execute(pool)
    .await
    .map_err(database_error)?;

    Ok(())
}

/// Credits the wallet for a payment Stripe reported, once. The amount paid must be
/// the amount the top-up asked for, and the customer the one it was opened for, or
/// nothing is credited. The top-up is marked paid, the wallet raised and the ledger
/// written in one transaction under the top-up's row, so a second report of the
/// same payment, even a simultaneous one, finds it paid and changes nothing.
pub(super) async fn complete_top_up(
    pool: &PgPool,
    top_up_id: Uuid,
    expected_user: Option<Uuid>,
    paid_micro: i64,
) -> Result<TopUpOutcome, ApiError> {
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let top_up: Option<(Uuid, i64, String)> = sqlx::query_as(
        "SELECT user_id, amount_micro, status FROM service_top_ups WHERE id = $1 FOR UPDATE",
    )
    .bind(top_up_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    let Some((user_id, amount_micro, status)) = top_up else {
        return Ok(TopUpOutcome::Unknown);
    };
    if status == "paid" {
        return Ok(TopUpOutcome::AlreadyCredited);
    }
    if paid_micro != amount_micro || expected_user.is_some_and(|expected| expected != user_id) {
        return Ok(TopUpOutcome::Mismatch);
    }
    sqlx::query("UPDATE service_top_ups SET status = 'paid', paid_at = NOW() WHERE id = $1")
        .bind(top_up_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    let wallet_micro = lock(&mut transaction, user_id)
        .await?
        .checked_add(amount_micro)
        .ok_or(ApiError::Validation("The amount is out of range."))?;
    set_wallet(&mut transaction, user_id, wallet_micro).await?;
    sqlx::query(
        "INSERT INTO service_ledger
         (id, user_id, kind, amount_micro, wallet_after_micro, top_up_id)
         VALUES ($1, $2, 'top_up', $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(amount_micro)
    .bind(wallet_micro)
    .bind(top_up_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;

    Ok(TopUpOutcome::Credited)
}

/// Takes the price of a ticket out of the wallet, in the transaction that sells it,
/// and answers what is left. A wallet that cannot cover it is refused and changes
/// nothing. A ticket is bought once, so a second purchase of it finds the ledger
/// row and is refused.
pub(super) async fn purchase(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    listing_id: Uuid,
    price_micro: i64,
) -> Result<i64, ApiError> {
    let wallet_micro = lock(transaction, user_id).await?;
    if wallet_micro < price_micro {
        return Err(ApiError::InsufficientBalance);
    }
    let inserted = sqlx::query(
        "INSERT INTO service_ledger
         (id, user_id, kind, amount_micro, wallet_after_micro, listing_id)
         VALUES ($1, $2, 'purchase', $3, $4, $5)
         ON CONFLICT (listing_id) WHERE kind = 'purchase' AND listing_id IS NOT NULL DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(price_micro)
    .bind(wallet_micro - price_micro)
    .bind(listing_id)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    set_wallet(transaction, user_id, wallet_micro - price_micro).await?;

    Ok(wallet_micro - price_micro)
}

/// Takes what a request cost out of the wallet, for the usage event it was sent
/// as, and returns what was taken. The wallet never goes below zero: a request
/// that costs more than is left takes what is left, and the rest is not
/// collected. An event is charged once, so a second charge for it takes nothing.
pub(super) async fn charge(
    pool: &PgPool,
    user_id: Uuid,
    usage_event_id: Uuid,
    cost_micro: i64,
) -> Result<i64, ApiError> {
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let wallet_micro = lock(&mut transaction, user_id).await?;
    let charged = cost_micro.min(wallet_micro);
    if charged <= 0 {
        return Ok(0);
    }
    let inserted = sqlx::query(
        "INSERT INTO service_ledger
         (id, user_id, kind, amount_micro, wallet_after_micro, usage_event_id)
         VALUES ($1, $2, 'usage', $3, $4, $5)
         ON CONFLICT (usage_event_id) WHERE usage_event_id IS NOT NULL DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(charged)
    .bind(wallet_micro - charged)
    .bind(usage_event_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    if inserted.rows_affected() == 0 {
        return Ok(0);
    }
    set_wallet(&mut transaction, user_id, wallet_micro - charged).await?;
    transaction.commit().await.map_err(database_error)?;

    Ok(charged)
}
