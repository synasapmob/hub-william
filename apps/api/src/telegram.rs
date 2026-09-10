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
    AppState,
    error::ApiError,
    telegram_catalogue::{load_product, normalize_slug},
};

const TELEGRAM_SERVICE_TOKEN_HEADER: &str = "x-hub-william-telegram-token";
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
    pub order: Option<TelegramOrder>,
}

const ORDER_COLUMNS: &str = "chat_id, expires_at, item_id, item_title, paid_at, quantity, reference, status, telegram_user_id, total_vnd, unit_price_vnd";

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

    let product = load_product(&state, &normalize_slug(&payload.product)?).await?;
    if !product.listed {
        return Err(ApiError::NotFound);
    }
    if payload.quantity > product.available {
        return Err(ApiError::Validation(
            "That quantity is more than the stock on hand.",
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
        .fetch_optional(&state.pool)
        .await
        .map_err(database_error)?;

        if let Some(order) = inserted {
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

pub async fn record_sepay_payment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(transaction): Json<SepayTransaction>,
) -> Result<Json<SepayResult>, ApiError> {
    authorize_telegram_service(&state, &headers)?;

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
    .bind(sepay_transferred_at(
        transaction.transaction_date.as_deref(),
    ))
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;

    let Some(payment_id) = payment_id else {
        database.commit().await.map_err(database_error)?;
        return Ok(Json(SepayResult {
            duplicate: true,
            order: None,
        }));
    };

    // Only money arriving can settle an order, and only a transfer that covers
    // the full total; anything else is recorded and left for a human.
    let order = if transaction.transfer_type.eq_ignore_ascii_case("in") {
        settle_order(
            &mut database,
            payment_id,
            &searchable_content(&transaction),
            transaction.transfer_amount,
        )
        .await?
    } else {
        None
    };

    database.commit().await.map_err(database_error)?;
    Ok(Json(SepayResult {
        duplicate: false,
        order,
    }))
}

async fn settle_order(
    database: &mut sqlx::PgConnection,
    payment_id: Uuid,
    content: &str,
    amount: i64,
) -> Result<Option<TelegramOrder>, ApiError> {
    // `FOR UPDATE SKIP LOCKED` keeps two transfers arriving together from
    // settling the same order; the second one simply finds no match.
    let order = sqlx::query_as::<_, TelegramOrder>(&format!(
        "WITH matched AS (
             SELECT id FROM telegram_orders
             WHERE status = 'awaiting_payment'
               AND POSITION(reference IN $2) > 0
               AND total_vnd <= $3
             ORDER BY created_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED
         ),
         settled AS (
             UPDATE telegram_orders
             SET status = 'paid', paid_at = NOW()
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
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;

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

pub(crate) fn authorize_telegram_service(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    let configured = state
        .config
        .telegram_service_token
        .as_deref()
        .ok_or(ApiError::Forbidden)?;
    let provided = headers
        .get(TELEGRAM_SERVICE_TOKEN_HEADER)
        .map(axum::http::HeaderValue::as_bytes)
        .unwrap_or_default();

    secrets_match(configured, provided)
        .then_some(())
        .ok_or(ApiError::Forbidden)
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

fn secrets_match(expected: &[u8], received: &[u8]) -> bool {
    let mut difference = expected.len() ^ received.len();
    let length = expected.len().max(received.len());

    for index in 0..length {
        let expected_byte = expected.get(index).copied().unwrap_or(0);
        let received_byte = received.get(index).copied().unwrap_or(0);
        difference |= usize::from(expected_byte ^ received_byte);
    }

    difference == 0
}

fn database_error(error: sqlx::Error) -> ApiError {
    eprintln!("telegram contact database operation failed: {error}");
    ApiError::Internal
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::{
        ORDER_REFERENCE_LENGTH, ObserveTelegramContact, SepayTransaction, normalize_contact,
        normalize_language, normalize_reference, order_reference, searchable_content,
        secrets_match, sepay_transferred_at,
    };

    #[test]
    fn contact_normalization_limits_public_metadata() {
        let contact = normalize_contact(ObserveTelegramContact {
            chat_id: 42,
            first_name: "  William  ".to_owned(),
            last_name: Some("  Hub  ".to_owned()),
            telegram_user_id: 99,
            username: Some("@Hub_William".to_owned()),
        })
        .expect("valid Telegram contact");

        assert_eq!(contact.username.as_deref(), Some("hub_william"));
        assert_eq!(contact.first_name, "William");
        assert_eq!(contact.last_name.as_deref(), Some("Hub"));
    }

    #[test]
    fn service_tokens_require_an_exact_match() {
        assert!(secrets_match(b"shared-secret", b"shared-secret"));
        assert!(!secrets_match(b"shared-secret", b"shared-secrex"));
        assert!(!secrets_match(b"shared-secret", b"shared-secret-more"));
    }

    #[test]
    fn language_is_limited_to_the_supported_locales() {
        assert_eq!(normalize_language(" EN ".to_owned()).unwrap(), "en");
        assert_eq!(normalize_language("vi".to_owned()).unwrap(), "vi");
        assert!(normalize_language("fr".to_owned()).is_err());
    }

    #[test]
    fn a_reference_is_normalized_and_bounded() {
        assert_eq!(
            normalize_reference(" 1gs0h75mmx9p ").unwrap(),
            "1GS0H75MMX9P"
        );
        assert!(normalize_reference("").is_err());
        assert!(normalize_reference("1GS0H75MMX9P0").is_err());
        assert!(normalize_reference("1GS0-H75MMX").is_err());
    }

    #[test]
    fn a_generated_reference_matches_the_column_constraint() {
        let reference = order_reference();

        assert_eq!(reference.chars().count(), ORDER_REFERENCE_LENGTH);
        assert_eq!(normalize_reference(&reference).unwrap(), reference);
    }

    #[test]
    fn a_transfer_note_matches_after_a_bank_rewrites_it() {
        let content = searchable_content(&sepay_transaction(Some(
            "CT DEN:520123 cam tien di chill thoi 1gs0h75mmx9p-Ma GD 123",
        )));

        assert!(content.contains("1GS0H75MMX9P"));
        assert!(!content.contains(' '));
    }

    #[test]
    fn a_sepay_payment_code_is_searched_alongside_the_free_text_note() {
        let mut transaction = sepay_transaction(Some("khong co ma"));
        transaction.code = Some("1GS0H75MMX9P".to_owned());

        assert!(searchable_content(&transaction).contains("1GS0H75MMX9P"));
    }

    #[test]
    fn a_sepay_timestamp_is_read_as_vietnamese_local_time() {
        assert_eq!(
            sepay_transferred_at(Some("2026-09-10 15:31:00")),
            Utc.with_ymd_and_hms(2026, 9, 10, 8, 31, 0).single()
        );
        assert!(sepay_transferred_at(None).is_none());
        assert!(sepay_transferred_at(Some("10/09/2026")).is_none());
    }

    fn sepay_transaction(content: Option<&str>) -> SepayTransaction {
        SepayTransaction {
            account_number: Some("19036951867026".to_owned()),
            code: None,
            content: content.map(str::to_owned),
            gateway: "Techcombank".to_owned(),
            id: 92_704,
            reference_code: Some("TCB.3278907687".to_owned()),
            transaction_date: Some("2026-09-10 15:31:00".to_owned()),
            transfer_amount: 270_000,
            transfer_type: "in".to_owned(),
        }
    }
}
