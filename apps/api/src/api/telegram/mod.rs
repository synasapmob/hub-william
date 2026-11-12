use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeDelta, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    api::{
        access::{Permission, identify},
        telegram::catalogue::{load_product_on, normalize_slug},
    },
    core::{ApiError, AppState},
};

pub(crate) mod accounts;
pub(crate) mod catalogue;
mod routes;
pub(crate) use routes::routes;

const ORDER_REFERENCE_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ORDER_REFERENCE_LENGTH: usize = 12;
const ORDER_REFERENCE_ATTEMPTS: usize = 8;
const MAXIMUM_ORDER_LIFETIME_MINUTES: i64 = 1_440;
const MAXIMUM_ORDER_QUANTITY: i32 = 1_000;
const RECENT_ORDER_LIMIT: i64 = 10;
const VIETNAM_UTC_OFFSET_SECONDS: i32 = 7 * 3_600;

#[derive(Debug, Deserialize)]
pub struct ObserveTelegramContact {
    pub chat_id: i64,
    pub first_name: String,
    pub last_name: Option<String>,
    pub telegram_user_id: i64,
    pub username: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TelegramContact {
    pub preferred_language: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetTelegramContactLanguage {
    pub language: String,
}

pub async fn observe_contact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ObserveTelegramContact>,
) -> Result<Json<TelegramContact>, ApiError> {
    authorize_telegram_service(&state, &headers)?;
    let contact = normalize_contact(payload)?;

    let preferred_language = sqlx::query_scalar::<_, Option<String>>(
        "INSERT INTO telegram_contacts
            (telegram_user_id, chat_id, username, first_name, last_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (telegram_user_id) DO UPDATE
         SET chat_id = EXCLUDED.chat_id,
             username = EXCLUDED.username,
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             last_seen_at = NOW()
         RETURNING preferred_language",
    )
    .bind(contact.telegram_user_id)
    .bind(contact.chat_id)
    .bind(contact.username)
    .bind(contact.first_name)
    .bind(contact.last_name)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;

    Ok(Json(TelegramContact { preferred_language }))
}

/// Reads a contact without touching `last_seen_at`, for work the bot starts on
/// its own — a payment notification is not the contact being active.
pub async fn get_contact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(telegram_user_id): Path<i64>,
) -> Result<Json<TelegramContact>, ApiError> {
    authorize_telegram_service(&state, &headers)?;

    let preferred_language = sqlx::query_scalar::<_, Option<String>>(
        "SELECT preferred_language FROM telegram_contacts WHERE telegram_user_id = $1",
    )
    .bind(telegram_user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    Ok(Json(TelegramContact { preferred_language }))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TelegramAudience {
    pub chat_id: i64,
    pub preferred_language: Option<String>,
}

/// Everyone who has started the bot and has not blocked it. This is the list an
/// announcement goes to; a blocked contact is skipped rather than retried.
pub async fn list_audience(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<TelegramAudience>>, ApiError> {
    authorize_telegram_service(&state, &headers)?;

    let audience = sqlx::query_as::<_, TelegramAudience>(
        "SELECT chat_id, preferred_language
         FROM telegram_contacts
         WHERE blocked_at IS NULL
         ORDER BY last_seen_at DESC",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    Ok(Json(audience))
}

/// Called when Telegram reports that a chat can no longer be written to.
pub async fn block_contact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(chat_id): Path<i64>,
) -> Result<Json<TelegramContact>, ApiError> {
    authorize_telegram_service(&state, &headers)?;

    let preferred_language = sqlx::query_scalar::<_, Option<String>>(
        "UPDATE telegram_contacts
         SET blocked_at = NOW()
         WHERE chat_id = $1
         RETURNING preferred_language",
    )
    .bind(chat_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    Ok(Json(TelegramContact { preferred_language }))
}

pub async fn set_contact_language(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(telegram_user_id): Path<i64>,
    Json(payload): Json<SetTelegramContactLanguage>,
) -> Result<Json<TelegramContact>, ApiError> {
    authorize_telegram_service(&state, &headers)?;
    if telegram_user_id <= 0 {
        return Err(ApiError::Validation(
            "Telegram contact identifiers must be positive.",
        ));
    }

    let language = normalize_language(payload.language)?;
    let preferred_language = sqlx::query_scalar::<_, Option<String>>(
        "UPDATE telegram_contacts
         SET preferred_language = $2,
             last_seen_at = NOW()
         WHERE telegram_user_id = $1
         RETURNING preferred_language",
    )
    .bind(telegram_user_id)
    .bind(language)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    Ok(Json(TelegramContact { preferred_language }))
}

/// The adapter names a product and a quantity; the price, the title and the
/// stock check are the API's, so a client can never set its own price.
#[derive(Debug, Deserialize)]
pub struct CreateTelegramOrder {
    pub chat_id: i64,
    pub lifetime_minutes: i64,
    pub product: String,
    pub quantity: i32,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TelegramOrder {
    pub chat_id: i64,
    pub expires_at: DateTime<Utc>,
    pub item_id: String,
    pub item_title: String,
    pub paid_at: Option<DateTime<Utc>>,
    pub quantity: i32,
    pub reference: String,
    pub status: String,
    pub telegram_user_id: i64,
    pub total_vnd: i64,
    pub unit_price_vnd: i64,
}

/// SePay's bank-transaction webhook body. Only the fields Hub William stores or
/// matches on are named; SePay may send more.
#[derive(Debug, Deserialize)]
pub struct SepayTransaction {
    #[serde(rename = "accountNumber")]
    pub account_number: Option<String>,
    pub code: Option<String>,
    pub content: Option<String>,
    pub gateway: String,
    pub id: i64,
    #[serde(rename = "referenceCode")]
    pub reference_code: Option<String>,
    #[serde(rename = "transactionDate")]
    pub transaction_date: Option<String>,
    #[serde(rename = "transferAmount")]
    pub transfer_amount: i64,
    #[serde(rename = "transferType")]
    pub transfer_type: String,
}

#[derive(Debug, Serialize)]
pub struct SepayResult {
    /// True when this SePay transaction was already recorded, so the caller
    /// must not notify the buyer a second time.
    pub duplicate: bool,
    /// Set when the transfer named an order that had already run out. Nothing is
    /// settled: the money is recorded for the owner, and the buyer is to be told
    /// to write to the owner, who gives them the goods or the money back.
    pub late: Option<LateTransfer>,
    pub order: Option<TelegramOrder>,
}

/// Money that arrived after the order it was meant for had run out.
#[derive(Debug, Serialize)]
pub struct LateTransfer {
    pub amount_vnd: i64,
    pub order: TelegramOrder,
}

pub(crate) const ORDER_COLUMNS: &str = "chat_id, expires_at, item_id, item_title, paid_at, quantity, reference, status, telegram_user_id, total_vnd, unit_price_vnd";

pub async fn create_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(telegram_user_id): Path<i64>,
    Json(payload): Json<CreateTelegramOrder>,
) -> Result<Json<TelegramOrder>, ApiError> {
    authorize_telegram_service(&state, &headers)?;
    if telegram_user_id <= 0 || payload.chat_id <= 0 {
        return Err(ApiError::Validation(
            "Telegram contact identifiers must be positive.",
        ));
    }
    if !(1..=MAXIMUM_ORDER_QUANTITY).contains(&payload.quantity) {
        return Err(ApiError::Validation(
            "A Telegram order quantity must be between 1 and 1000.",
        ));
    }
    if !(1..=MAXIMUM_ORDER_LIFETIME_MINUTES).contains(&payload.lifetime_minutes) {
        return Err(ApiError::Validation(
            "A Telegram order lifetime must be between 1 and 1440 minutes.",
        ));
    }

    let slug = normalize_slug(&payload.product)?;

    // A buyer holds one open order at a time. The same transaction cancels the
    // earlier one and creates the new one, so a request that is refused below
    // leaves the earlier order as it was. The per-buyer lock keeps two requests
    // from the same buyer from each cancelling the other's new order.
    let mut database = state.pool.begin().await.map_err(database_error)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('telegram-order:' || $1::text, 0))")
        .bind(telegram_user_id)
        .execute(&mut *database)
        .await
        .map_err(database_error)?;
    // Only an order still inside its time. One that has run out stays waiting for
    // the owner, who can settle it by hand if its money turns up late.
    sqlx::query(
        "UPDATE telegram_orders
         SET status = 'cancelled'
         WHERE telegram_user_id = $1 AND status = 'awaiting_payment' AND expires_at > NOW()",
    )
    .bind(telegram_user_id)
    .execute(&mut *database)
    .await
    .map_err(database_error)?;

    // Read after the cancellation, so stock the earlier order held counts as free.
    let product = load_product_on(&mut database, &slug).await?;
    if !product.listed {
        return Err(ApiError::NotFound);
    }
    if payload.quantity > product.available {
        return Err(ApiError::Validation(
            "That quantity is more than the stock on hand.",
        ));
    }
    if product.delivers_accounts && payload.quantity > accounts::MAXIMUM_ACCOUNTS_PER_ORDER {
        return Err(ApiError::Validation(
            "A package that hands out accounts sells at most 10 in one order.",
        ));
    }

    let quantity = payload.quantity;
    let unit_price_vnd = product.price_vnd;
    let total_vnd = unit_price_vnd * i64::from(quantity);
    let expires_at = Utc::now() + TimeDelta::minutes(payload.lifetime_minutes);

    // A reference collision is a lost race against another buyer, not a client
    // error, so retry a fresh one rather than surfacing the conflict.
    for _ in 0..ORDER_REFERENCE_ATTEMPTS {
        let inserted = sqlx::query_as::<_, TelegramOrder>(&format!(
            "INSERT INTO telegram_orders
                (id, reference, telegram_user_id, chat_id, item_id, item_title,
                 quantity, unit_price_vnd, total_vnd, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (reference) DO NOTHING
             RETURNING {ORDER_COLUMNS}"
        ))
        .bind(Uuid::new_v4())
        .bind(order_reference())
        .bind(telegram_user_id)
        .bind(payload.chat_id)
        .bind(&product.slug)
        .bind(product.title())
        .bind(quantity)
        .bind(unit_price_vnd)
        .bind(total_vnd)
        .bind(expires_at)
        .fetch_optional(&mut *database)
        .await
        .map_err(database_error)?;

        if let Some(order) = inserted {
            database.commit().await.map_err(database_error)?;

            return Ok(Json(order));
        }
    }

    eprintln!("telegram order reference generation exhausted its attempts");
    Err(ApiError::Internal)
}

pub async fn get_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((telegram_user_id, reference)): Path<(i64, String)>,
) -> Result<Json<TelegramOrder>, ApiError> {
    authorize_telegram_service(&state, &headers)?;

    let order = sqlx::query_as::<_, TelegramOrder>(&format!(
        "SELECT {ORDER_COLUMNS} FROM telegram_orders
         WHERE telegram_user_id = $1 AND reference = $2"
    ))
    .bind(telegram_user_id)
    .bind(normalize_reference(&reference)?)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    Ok(Json(order))
}

pub async fn list_orders(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(telegram_user_id): Path<i64>,
) -> Result<Json<Vec<TelegramOrder>>, ApiError> {
    authorize_telegram_service(&state, &headers)?;

    let orders = sqlx::query_as::<_, TelegramOrder>(&format!(
        "SELECT {ORDER_COLUMNS} FROM telegram_orders
         WHERE telegram_user_id = $1
         ORDER BY created_at DESC
         LIMIT $2"
    ))
    .bind(telegram_user_id)
    .bind(RECENT_ORDER_LIMIT)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    Ok(Json(orders))
}

/// Cancelling only stops an order from being matched later; a transfer that
/// already arrived stays recorded against it.
pub async fn cancel_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((telegram_user_id, reference)): Path<(i64, String)>,
) -> Result<Json<TelegramOrder>, ApiError> {
    authorize_telegram_service(&state, &headers)?;

    let order = sqlx::query_as::<_, TelegramOrder>(&format!(
        "UPDATE telegram_orders
         SET status = 'cancelled'
         WHERE telegram_user_id = $1 AND reference = $2 AND status = 'awaiting_payment'
         RETURNING {ORDER_COLUMNS}"
    ))
    .bind(telegram_user_id)
    .bind(normalize_reference(&reference)?)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    Ok(Json(order))
}

/// What a paid order was handed, for its buyer. The accounts come back to the one
/// contact whose order it is and to nobody else, and again on every ask, so a
/// buyer whose message did not arrive can have them sent once more.
pub async fn order_delivery(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((telegram_user_id, reference)): Path<(i64, String)>,
) -> Result<Json<accounts::Delivery>, ApiError> {
    authorize_telegram_service(&state, &headers)?;

    Ok(Json(
        accounts::delivery_for_order(&state, telegram_user_id, &normalize_reference(&reference)?)
            .await?,
    ))
}

pub async fn record_sepay_payment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(transaction): Json<SepayTransaction>,
) -> Result<Json<SepayResult>, ApiError> {
    authorize_telegram_service(&state, &headers)?;

    let transferred_at = sepay_transferred_at(transaction.transaction_date.as_deref());

    let mut database = state.pool.begin().await.map_err(database_error)?;
    let payment_id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO telegram_payments
            (id, sepay_transaction_id, gateway, account_number, amount_vnd,
             content, transfer_type, bank_reference, transferred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (sepay_transaction_id) DO NOTHING
         RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(transaction.id)
    .bind(truncate(&transaction.gateway, 64))
    .bind(
        transaction
            .account_number
            .as_deref()
            .map(|value| truncate(value, 64)),
    )
    .bind(transaction.transfer_amount)
    .bind(transaction.content.clone().unwrap_or_default())
    .bind(truncate(&transaction.transfer_type, 8))
    .bind(
        transaction
            .reference_code
            .as_deref()
            .map(|value| truncate(value, 64)),
    )
    .bind(transferred_at)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;

    let Some(payment_id) = payment_id else {
        database.commit().await.map_err(database_error)?;
        return Ok(Json(SepayResult {
            duplicate: true,
            late: None,
            order: None,
        }));
    };

    // Only money arriving can settle an order, only a transfer that covers the
    // full total, and only one made before the order ran out; anything else is
    // recorded and left for a human.
    let paid_by = transferred_at.unwrap_or_else(Utc::now);
    let content = searchable_content(&transaction);
    let money_in = transaction.transfer_type.eq_ignore_ascii_case("in");
    let order = if money_in {
        settle_order(
            &mut database,
            payment_id,
            &content,
            transaction.transfer_amount,
            Some(paid_by),
        )
        .await?
    } else {
        None
    };
    // Money that names an order which had already run out settles nothing, so
    // the buyer would hear nothing either. Say who it was for.
    let late = if money_in && order.is_none() {
        find_expired_order(&mut database, &content, paid_by)
            .await?
            .map(|order| LateTransfer {
                amount_vnd: transaction.transfer_amount,
                order,
            })
    } else {
        None
    };

    database.commit().await.map_err(database_error)?;
    Ok(Json(SepayResult {
        duplicate: false,
        late,
        order,
    }))
}

/// The order a transfer names, when it had run out before the money moved.
async fn find_expired_order(
    database: &mut sqlx::PgConnection,
    content: &str,
    paid_by: DateTime<Utc>,
) -> Result<Option<TelegramOrder>, ApiError> {
    sqlx::query_as::<_, TelegramOrder>(&format!(
        "SELECT {ORDER_COLUMNS} FROM telegram_orders
         WHERE status = 'awaiting_payment'
           AND POSITION(reference IN $1) > 0
           AND expires_at <= $2
         ORDER BY created_at DESC
         LIMIT 1"
    ))
    .bind(content)
    .bind(paid_by)
    .fetch_optional(database)
    .await
    .map_err(database_error)
}

async fn settle_order(
    database: &mut sqlx::PgConnection,
    payment_id: Uuid,
    content: &str,
    amount: i64,
    transferred_at: Option<DateTime<Utc>>,
) -> Result<Option<TelegramOrder>, ApiError> {
    // An order is only good until `expires_at`. What counts is when the bank
    // moved the money, so a transfer made in time still settles when its
    // webhook arrives a moment late; without the bank's time it is now.
    let paid_by = transferred_at.unwrap_or_else(Utc::now);

    // `FOR UPDATE SKIP LOCKED` keeps two transfers arriving together from
    // settling the same order; the second one simply finds no match.
    let order = sqlx::query_as::<_, TelegramOrder>(&format!(
        "WITH matched AS (
             SELECT id FROM telegram_orders
             WHERE status = 'awaiting_payment'
               AND POSITION(reference IN $2) > 0
               AND total_vnd <= $3
               AND expires_at > $4
             ORDER BY created_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED
         ),
         settled AS (
             UPDATE telegram_orders
             SET status = 'paid', paid_at = NOW(), payment_method = 'bank_transfer'
             WHERE id IN (SELECT id FROM matched)
             RETURNING {ORDER_COLUMNS}
         ),
         linked AS (
             UPDATE telegram_payments
             SET order_id = (SELECT id FROM matched)
             WHERE id = $1 AND EXISTS (SELECT 1 FROM matched)
         )
         SELECT {ORDER_COLUMNS} FROM settled"
    ))
    .bind(payment_id)
    .bind(content)
    .bind(amount)
    .bind(paid_by)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;

    // A paid order stops reserving stock and starts consuming it, and a package
    // that hands out accounts hands them to the order here, in the same
    // transaction as the payment.
    if let Some(order) = order.as_ref() {
        accounts::use_up_stock(database, &order.item_id, &order.reference, order.quantity).await?;
    }

    Ok(order)
}

struct NormalizedTelegramContact {
    chat_id: i64,
    first_name: String,
    last_name: Option<String>,
    telegram_user_id: i64,
    username: Option<String>,
}

fn normalize_reference(value: &str) -> Result<String, ApiError> {
    let reference = value.trim().to_ascii_uppercase();
    if reference.is_empty()
        || reference.chars().count() > ORDER_REFERENCE_LENGTH
        || !reference
            .chars()
            .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
    {
        return Err(ApiError::Validation(
            "A Telegram order reference is 1-12 uppercase letters or digits.",
        ));
    }
    Ok(reference)
}

/// Banks rewrite a transfer note freely — case, spacing and punctuation all
/// change — so matching happens against the letters and digits that survive.
fn searchable_content(transaction: &SepayTransaction) -> String {
    let mut content = String::new();
    for part in [transaction.code.as_deref(), transaction.content.as_deref()]
        .into_iter()
        .flatten()
    {
        content.push_str(part);
    }
    content
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect()
}

/// SePay stamps a transfer in Vietnamese local time without an offset.
fn sepay_transferred_at(value: Option<&str>) -> Option<DateTime<Utc>> {
    let offset = FixedOffset::east_opt(VIETNAM_UTC_OFFSET_SECONDS)?;
    NaiveDateTime::parse_from_str(value?.trim(), "%Y-%m-%d %H:%M:%S")
        .ok()?
        .and_local_timezone(offset)
        .single()
        .map(|stamped| stamped.with_timezone(&Utc))
}

fn order_reference() -> String {
    let mut generator = rand::thread_rng();
    (0..ORDER_REFERENCE_LENGTH)
        .map(|_| {
            char::from(
                ORDER_REFERENCE_ALPHABET[generator.gen_range(0..ORDER_REFERENCE_ALPHABET.len())],
            )
        })
        .collect()
}

fn truncate(value: &str, maximum_characters: usize) -> String {
    value.trim().chars().take(maximum_characters).collect()
}

/// Every `/internal/telegram/*` route is the bot's alone. Whatever is wrong with the
/// key, the answer is the same `403`, so a probe learns nothing about which part failed.
pub(crate) fn authorize_telegram_service(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    identify(&state.config, headers)
        .ok_or(ApiError::Forbidden)?
        .require(Permission::Internal)
}

fn normalize_contact(
    payload: ObserveTelegramContact,
) -> Result<NormalizedTelegramContact, ApiError> {
    if payload.telegram_user_id <= 0 || payload.chat_id <= 0 {
        return Err(ApiError::Validation(
            "Telegram contact identifiers must be positive.",
        ));
    }

    let first_name = normalize_text(payload.first_name, 128)
        .ok_or(ApiError::Validation("Telegram first name is required."))?;

    Ok(NormalizedTelegramContact {
        chat_id: payload.chat_id,
        first_name,
        last_name: normalize_text(payload.last_name.unwrap_or_default(), 128),
        telegram_user_id: payload.telegram_user_id,
        username: normalize_text(payload.username.unwrap_or_default(), 32)
            .map(|username| username.trim_start_matches('@').to_ascii_lowercase()),
    })
}

fn normalize_text(value: String, maximum_characters: usize) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.chars().take(maximum_characters).collect())
}

fn normalize_language(value: String) -> Result<String, ApiError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "en" | "vi" => Ok(value.trim().to_ascii_lowercase()),
        _ => Err(ApiError::Validation(
            "Telegram language must be either en or vi.",
        )),
    }
}

fn database_error(error: sqlx::Error) -> ApiError {
    crate::utils::database_error("telegram contact", error)
}

#[cfg(test)]
mod tests;

#[cfg(all(test, feature = "database-tests"))]
mod database_tests;
