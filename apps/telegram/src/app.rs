use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    catalog::{Catalogue, Product},
    checkout::{ORDER_LIFETIME_MINUTES, Order, OrderStatus, Pending, Sessions},
    config::AppConfig,
    language::Language,
    telegram::{self, Reply},
    view,
};

const API_SERVICE_TOKEN_HEADER: &str = "x-hub-william-telegram-token";
const TELEGRAM_WEBHOOK_SECRET_HEADER: &str = "x-telegram-bot-api-secret-token";
const SEPAY_AUTHORIZATION_SCHEME: &str = "Apikey ";
/// Telegram truncates a callback notice past this, so the adapter does it first.
const MAXIMUM_NOTICE_CHARACTERS: usize = 200;
const BUSY_NOTICE: &str = "⚠️ Thử lại giúp mình nhé / Please try again.";
const AUDIENCE_PATH: &str = "/internal/telegram/audience";
/// Telegram caps bulk sending near 30 messages a second; this stays under it.
const BROADCAST_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
const QR_IMAGE: &[u8] = include_bytes!("../assets/qr-bank.png");

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub http: Client,
    pub sessions: Sessions,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/qr.png", get(qr_image))
        .route("/sepay", post(sepay_webhook))
        .route("/webhook", post(webhook))
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "hub-william-telegram",
    })
}

/// The shop's payment QR, served publicly because Telegram fetches a photo by
/// URL. It is a fixed image of a receiving account, not per-buyer data.
async fn qr_image() -> Response {
    png(QR_IMAGE)
}

fn png(image: &'static [u8]) -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        image,
    )
        .into_response()
}

async fn webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(update): Json<telegram::Update>,
) -> Result<Response, StatusCode> {
    if !webhook_secret_matches(&state.config.webhook_secret, &headers) {
        return Err(StatusCode::FORBIDDEN);
    }

    if let Some(message) = update.message {
        return handle_message(&state, message).await;
    }
    if let Some(callback) = update.callback_query {
        return handle_callback(&state, callback).await;
    }

    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn handle_message(
    state: &AppState,
    message: telegram::Message,
) -> Result<Response, StatusCode> {
    let Some(from) = message.from else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if message.chat.kind != "private" || from.is_bot {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    let language = observe_contact(state, &message.chat, &from).await?;
    let Some(text) = message.text.as_deref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let username = from.username.as_deref();
    let reply = match command_reply(state, message.chat.id, from.id, username, text, language)
        .await?
    {
        Some(reply) => Some(reply),
        None => pending_reply(state, message.chat.id, from.id, username, text, language).await?,
    };
    let Some(reply) = reply else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };

    Ok(Json(reply).into_response())
}

/// SePay posts here when money lands in the shop's bank account. The adapter is
/// the only publicly reachable service, so it authenticates the call and hands
/// the transaction to the API, which owns orders and payments.
async fn sepay_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(transaction): Json<serde_json::Value>,
) -> Result<Response, StatusCode> {
    let Some(expected) = state.config.sepay_api_key.as_deref() else {
        eprintln!("SePay webhook rejected because SEPAY_API_KEY is not configured");
        return Err(StatusCode::FORBIDDEN);
    };
    if !sepay_key_matches(expected, &headers) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let result: SepayResult = call_api(
        &state,
        Method::POST,
        "/internal/telegram/payments/sepay",
        Some(transaction),
    )
    .await?
    .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    // The payment is already recorded. A failed notification must not make
    // SePay retry, because the retry would be deduplicated and the buyer would
    // then never hear about it; the check button still reports the truth.
    if let Some(order) = result.order.as_ref()
        && let Err(status) = notify_paid(&state, order).await
    {
        eprintln!("Telegram payment notification failed with status {status}");
    }

    Ok(Json(SepayAcknowledgement { success: true }).into_response())
}

async fn notify_paid(state: &AppState, order: &Order) -> Result<(), StatusCode> {
    let language = contact_language(state, order.telegram_user_id)
        .await
        .unwrap_or(Language::Vietnamese);
    let endpoint = state
        .config
        .telegram_api_base_url
        .join(&format!("/bot{}/sendMessage", state.config.bot_token))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let response = state
        .http
        .post(endpoint)
        .json(&view::payment_received(order.chat_id, language, order))
        .send()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    response
        .status()
        .is_success()
        .then_some(())
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)
}

fn sepay_key_matches(expected: &str, headers: &HeaderMap) -> bool {
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix(SEPAY_AUTHORIZATION_SCHEME))
        .unwrap_or_default();
    secrets_match(expected.as_bytes(), provided.as_bytes())
}

async fn handle_callback(
    state: &AppState,
    callback: telegram::CallbackQuery,
) -> Result<Response, StatusCode> {
    let Some(message) = callback.message.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if message.chat.kind != "private" || callback.from.is_bot {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    // The callback is deliberately left unanswered until the work is done:
    // Telegram keeps the tapped button in its loading state until it is, which
    // is the only progress a buyer sees while the API round trips run.
    let outcome = resolve_callback(state, message, &callback).await;
    let notice = match &outcome {
        Ok(Outcome::Alert(text)) => Some(text.as_str()),
        Err(_) => Some(BUSY_NOTICE),
        _ => None,
    };
    if let Err(status) = acknowledge_callback(state, &callback.id, notice).await {
        eprintln!("Telegram callback acknowledgement failed with status {status}");
    }

    match outcome? {
        // Replacing keeps the chat to one live panel instead of stacking a new
        // message under every tap.
        Outcome::Replace(reply) => {
            if let Err(status) = delete_message(state, message.chat.id, message.message_id).await {
                eprintln!("Telegram message removal failed with status {status}");
            }
            Ok(Json(reply).into_response())
        }
        Outcome::Edit(edit) => Ok(Json(Reply::from(edit)).into_response()),
        Outcome::Alert(_) | Outcome::Nothing => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

async fn resolve_callback(
    state: &AppState,
    message: &telegram::CallbackMessage,
    callback: &telegram::CallbackQuery,
) -> Result<Outcome, StatusCode> {
    let observed_language = observe_contact(state, &message.chat, &callback.from).await?;
    let Some(data) = callback.data.as_deref() else {
        return Ok(Outcome::Nothing);
    };

    callback_reply(
        state,
        message.chat.id,
        message.message_id,
        callback.from.id,
        callback.from.username.as_deref(),
        data,
        observed_language,
    )
    .await
}

/// Every private-API call goes through here. A 404 is a real answer — "no such
/// order" — so it is returned as `None` rather than an error.
async fn call_api<R: DeserializeOwned>(
    state: &AppState,
    method: Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<Option<R>, StatusCode> {
    let endpoint = state
        .config
        .api_internal_url
        .join(path)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut request = state
        .http
        .request(method, endpoint)
        .header(API_SERVICE_TOKEN_HEADER, &state.config.api_service_token);
    if let Some(body) = body {
        request = request.json(&body);
    }

    let response = request.send().await.map_err(|_| {
        eprintln!("Hub API request to {path} failed");
        StatusCode::SERVICE_UNAVAILABLE
    })?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        eprintln!(
            "Hub API responded to {path} with status {}",
            response.status()
        );
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    response.json().await.map(Some).map_err(|_| {
        eprintln!("Hub API returned an invalid response for {path}");
        StatusCode::SERVICE_UNAVAILABLE
    })
}

async fn observe_contact(
    state: &AppState,
    chat: &telegram::Chat,
    user: &telegram::User,
) -> Result<Option<Language>, StatusCode> {
    let contact: TelegramContact = call_api(
        state,
        Method::POST,
        "/internal/telegram/contacts",
        Some(serde_json::json!({
            "chat_id": chat.id,
            "first_name": user.first_name,
            "last_name": user.last_name,
            "telegram_user_id": user.id,
            "username": user.username,
        })),
    )
    .await?
    .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    Ok(contact
        .preferred_language
        .as_deref()
        .and_then(Language::parse))
}

/// Reads a contact's stored preference without touching `last_seen_at`, for
/// messages the bot sends on its own rather than in reply to the buyer.
async fn contact_language(state: &AppState, telegram_user_id: i64) -> Option<Language> {
    let contact: TelegramContact = call_api(
        state,
        Method::GET,
        &format!("/internal/telegram/contacts/{telegram_user_id}"),
        None,
    )
    .await
    .ok()??;
    contact
        .preferred_language
        .as_deref()
        .and_then(Language::parse)
}

async fn set_language(
    state: &AppState,
    telegram_user_id: i64,
    language: Language,
) -> Result<Language, StatusCode> {
    let contact: TelegramContact = call_api(
        state,
        Method::PUT,
        &format!("/internal/telegram/contacts/{telegram_user_id}/language"),
        Some(serde_json::json!({ "language": language.code() })),
    )
    .await?
    .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    contact
        .preferred_language
        .as_deref()
        .and_then(Language::parse)
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)
}

async fn fetch_catalogue(state: &AppState) -> Result<Catalogue, StatusCode> {
    call_api(state, Method::GET, "/internal/telegram/catalogue", None)
        .await?
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)
}

/// The owner's view includes hidden products, so a mistake can be undone.
async fn fetch_full_catalogue(state: &AppState) -> Result<Catalogue, StatusCode> {
    call_api(
        state,
        Method::GET,
        "/internal/telegram/catalogue/full",
        None,
    )
    .await?
    .ok_or(StatusCode::SERVICE_UNAVAILABLE)
}

async fn fetch_product(state: &AppState, slug: &str) -> Result<Option<Product>, StatusCode> {
    call_api(
        state,
        Method::GET,
        &format!("/internal/telegram/products/{slug}"),
        None,
    )
    .await
}

async fn create_order(
    state: &AppState,
    telegram_user_id: i64,
    chat_id: i64,
    product: &Product,
    quantity: i64,
) -> Result<Option<Order>, StatusCode> {
    call_api(
        state,
        Method::POST,
        &format!("/internal/telegram/contacts/{telegram_user_id}/orders"),
        Some(serde_json::json!({
            "chat_id": chat_id,
            "lifetime_minutes": ORDER_LIFETIME_MINUTES,
            "product": product.slug,
            "quantity": quantity,
        })),
    )
    .await
}

async fn fetch_order(
    state: &AppState,
    telegram_user_id: i64,
    reference: &str,
) -> Result<Option<Order>, StatusCode> {
    call_api(
        state,
        Method::GET,
        &format!("/internal/telegram/contacts/{telegram_user_id}/orders/{reference}"),
        None,
    )
    .await
}

async fn stop_order(
    state: &AppState,
    telegram_user_id: i64,
    reference: &str,
) -> Result<Option<Order>, StatusCode> {
    call_api(
        state,
        Method::POST,
        &format!("/internal/telegram/contacts/{telegram_user_id}/orders/{reference}/cancel"),
        None,
    )
    .await
}

async fn restock_product(
    state: &AppState,
    slug: &str,
    added: i64,
) -> Result<Option<Restock>, StatusCode> {
    call_api(
        state,
        Method::POST,
        &format!("/internal/telegram/products/{slug}/restock"),
        Some(serde_json::json!({ "added": added })),
    )
    .await
}

async fn adjust_product(
    state: &AppState,
    slug: &str,
    change: serde_json::Value,
) -> Result<Option<Product>, StatusCode> {
    call_api(
        state,
        Method::PATCH,
        &format!("/internal/telegram/products/{slug}"),
        Some(change),
    )
    .await
}

async fn create_product(
    state: &AppState,
    draft: serde_json::Value,
) -> Result<Option<Product>, StatusCode> {
    call_api(
        state,
        Method::POST,
        "/internal/telegram/products",
        Some(draft),
    )
    .await
}

/// Best effort throughout: the stock is already added, so a chat that cannot be
/// written to must not turn the restock itself into a failure.
async fn announce_restock(state: &AppState, added: i64, product: &Product) {
    if let Some(chat_id) = state.config.announce_chat_id.clone() {
        let post = view::restock_channel_post(
            chat_id,
            added,
            product,
            state.config.bot_username.as_deref(),
        );
        if let Ok(body) = serde_json::to_value(&post)
            && let Err(status) = call_telegram(state, "sendMessage", body).await
        {
            eprintln!("Telegram channel announcement failed with status {status}");
        }
    }

    // The fan-out runs detached so the owner's own reply is not held behind it,
    // and it is paced under Telegram's bulk-message limit.
    let state = state.clone();
    let product = product.clone();
    tokio::spawn(async move {
        broadcast_restock(&state, added, &product).await;
    });
}

async fn broadcast_restock(state: &AppState, added: i64, product: &Product) {
    let audience: Vec<Audience> = match call_api(state, Method::GET, AUDIENCE_PATH, None).await {
        Ok(Some(audience)) => audience,
        Ok(None) => Vec::new(),
        Err(status) => {
            eprintln!("Telegram audience lookup failed with status {status}");
            return;
        }
    };

    for contact in audience {
        let message = view::restock_announcement(
            contact.chat_id,
            added,
            product,
            state.config.bot_username.as_deref(),
        );
        let Ok(body) = serde_json::to_value(&message) else {
            continue;
        };

        // A chat that answers 403 has blocked the bot; recording it keeps the
        // next announcement from spending a send on them again.
        if let Err(status) = call_telegram(state, "sendMessage", body).await
            && status == StatusCode::FORBIDDEN
        {
            let _: Result<Option<serde_json::Value>, _> = call_api(
                state,
                Method::POST,
                &format!("{AUDIENCE_PATH}/{}/block", contact.chat_id),
                None,
            )
            .await;
        }

        tokio::time::sleep(BROADCAST_INTERVAL).await;
    }
}

async fn fetch_orders(state: &AppState, telegram_user_id: i64) -> Result<Vec<Order>, StatusCode> {
    Ok(call_api(
        state,
        Method::GET,
        &format!("/internal/telegram/contacts/{telegram_user_id}/orders"),
        None,
    )
    .await?
    .unwrap_or_default())
}

/// Every Bot API call the adapter makes outside its webhook reply.
async fn call_telegram(
    state: &AppState,
    method: &str,
    body: serde_json::Value,
) -> Result<(), StatusCode> {
    let endpoint = state
        .config
        .telegram_api_base_url
        .join(&format!("/bot{}/{method}", state.config.bot_token))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let response = state
        .http
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            let error = error.without_url();
            eprintln!(
                "Telegram {method} transport failure (connect={}, timeout={}, request={}, status={}): {error:?}",
                error.is_connect(),
                error.is_timeout(),
                error.is_request(),
                error.is_status(),
            );
            StatusCode::SERVICE_UNAVAILABLE
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let succeeded = status.is_success()
        && serde_json::from_str::<telegram::ApiResult>(&body)
            .map(|result| result.ok)
            .unwrap_or(false);
    if succeeded {
        Ok(())
    } else {
        eprintln!(
            "Telegram {method} failed with status {status}: {}",
            sanitize_telegram_error(&body)
        );
        Err(StatusCode::SERVICE_UNAVAILABLE)
    }
}

/// A `notice` is shown as a popup the buyer has to dismiss, which is how a
/// result that does not deserve its own chat message gets delivered.
async fn acknowledge_callback(
    state: &AppState,
    callback_query_id: &str,
    notice: Option<&str>,
) -> Result<(), StatusCode> {
    // `text` is omitted rather than sent as JSON null, which Telegram renders
    // to the buyer as a floating "null".
    let mut body = serde_json::json!({ "callback_query_id": callback_query_id });
    if let Some(notice) = notice {
        body["show_alert"] = serde_json::Value::Bool(true);
        body["text"] =
            serde_json::Value::String(notice.chars().take(MAXIMUM_NOTICE_CHARACTERS).collect());
    }

    call_telegram(state, "answerCallbackQuery", body).await
}

async fn delete_message(state: &AppState, chat_id: i64, message_id: i64) -> Result<(), StatusCode> {
    call_telegram(
        state,
        "deleteMessage",
        serde_json::json!({ "chat_id": chat_id, "message_id": message_id }),
    )
    .await
}

/// Telegram's typing indicator, the only progress a buyer can be shown while a
/// plain message — rather than a button — is being answered.
async fn show_typing(state: &AppState, chat_id: i64) {
    if let Err(status) = call_telegram(
        state,
        "sendChatAction",
        serde_json::json!({ "action": "typing", "chat_id": chat_id }),
    )
    .await
    {
        eprintln!("Telegram typing indicator failed with status {status}");
    }
}

fn sanitize_telegram_error(body: &str) -> String {
    body.chars().take(256).collect()
}

/// What a tapped button does to the chat.
enum Outcome {
    /// Say it in a popup and leave the chat exactly as it was.
    Alert(String),
    /// Rewrite the message the button belongs to.
    Edit(telegram::EditMessageText),
    Nothing,
    /// Remove that message and send this one in its place.
    Replace(Reply),
}

async fn callback_reply(
    state: &AppState,
    chat_id: i64,
    message_id: i64,
    telegram_user_id: i64,
    username: Option<&str>,
    data: &str,
    observed_language: Option<Language>,
) -> Result<Outcome, StatusCode> {
    if let Some(language) = data.strip_prefix("language:").and_then(Language::parse) {
        let language = set_language(state, telegram_user_id, language).await?;
        let catalogue = fetch_catalogue(state).await?;
        return Ok(Outcome::Edit(view::edit_menu(
            chat_id, message_id, language, &catalogue,
        )));
    }

    let language = observed_language.unwrap_or(Language::Vietnamese);
    // Shop screens are all text, so browsing rewrites one message in place.
    // Only a payment panel, which is a photo, has to replace it.
    if data == "menu" {
        let catalogue = fetch_catalogue(state).await?;
        return Ok(Outcome::Edit(view::edit_menu(
            chat_id, message_id, language, &catalogue,
        )));
    }
    if let Some(slug) = data.strip_prefix("provider:") {
        let catalogue = fetch_catalogue(state).await?;
        return Ok(match catalogue.provider(slug) {
            Some(provider) => {
                Outcome::Edit(view::edit_provider(chat_id, message_id, language, provider))
            }
            None => Outcome::Edit(view::edit_menu(chat_id, message_id, language, &catalogue)),
        });
    }
    if let Some(slug) = data.strip_prefix("catalog:") {
        let Some(product) = fetch_product(state, slug).await? else {
            let catalogue = fetch_catalogue(state).await?;
            return Ok(Outcome::Edit(view::edit_menu(
                chat_id, message_id, language, &catalogue,
            )));
        };
        state
            .sessions
            .expect(telegram_user_id, Pending::Quantity(product.slug.clone()));
        return Ok(Outcome::Edit(view::edit_quantity_prompt(
            chat_id, message_id, language, &product,
        )));
    }
    if let Some(action) = data.strip_prefix("pay:") {
        return payment_outcome(state, chat_id, telegram_user_id, language, action).await;
    }
    if let Some(action) = data.strip_prefix("admin") {
        return admin_outcome(
            state,
            chat_id,
            message_id,
            telegram_user_id,
            username,
            action,
        )
        .await;
    }

    Ok(Outcome::Nothing)
}

/// The stock room. Ownership is checked here rather than only on `/catalog`,
/// so a button that outlives someone's owner status stops working.
async fn admin_outcome(
    state: &AppState,
    chat_id: i64,
    message_id: i64,
    telegram_user_id: i64,
    username: Option<&str>,
    action: &str,
) -> Result<Outcome, StatusCode> {
    if !state.config.owners.includes(telegram_user_id, username) {
        return Ok(Outcome::Nothing);
    }

    let action = action.trim_start_matches(':');
    if action.is_empty() {
        state.sessions.clear(telegram_user_id);
        let catalogue = fetch_full_catalogue(state).await?;
        return Ok(Outcome::Edit(view::edit_admin_catalogue(
            chat_id, message_id, &catalogue,
        )));
    }
    if action == "new" {
        state.sessions.expect(telegram_user_id, Pending::NewProduct);
        return Ok(Outcome::Edit(view::admin_new_product_prompt(
            chat_id, message_id,
        )));
    }

    let Some((action, slug)) = action.split_once(':') else {
        return Ok(Outcome::Nothing);
    };
    let Some(product) = fetch_product(state, slug).await? else {
        let catalogue = fetch_full_catalogue(state).await?;
        return Ok(Outcome::Edit(view::edit_admin_catalogue(
            chat_id, message_id, &catalogue,
        )));
    };

    let product = match action {
        "open" => {
            state.sessions.clear(telegram_user_id);
            product
        }
        "restock" => {
            state
                .sessions
                .expect(telegram_user_id, Pending::Restock(product.slug.clone()));
            return Ok(Outcome::Edit(view::admin_restock_prompt(
                chat_id, message_id, &product,
            )));
        }
        "price" => {
            state
                .sessions
                .expect(telegram_user_id, Pending::Price(product.slug.clone()));
            return Ok(Outcome::Edit(view::admin_price_prompt(
                chat_id, message_id, &product,
            )));
        }
        "hot" => adjust_product(state, slug, serde_json::json!({ "hot": !product.hot }))
            .await?
            .unwrap_or(product),
        "listed" => adjust_product(
            state,
            slug,
            serde_json::json!({ "listed": !product.listed }),
        )
        .await?
        .unwrap_or(product),
        _ => return Ok(Outcome::Nothing),
    };

    Ok(Outcome::Edit(view::edit_admin_product(
        chat_id, message_id, &product,
    )))
}

/// Every payment button carries its own order reference and the order is read
/// back from the API, so a button left in an older message acts on that exact
/// order — or on nothing, once it is settled or stopped.
async fn payment_outcome(
    state: &AppState,
    chat_id: i64,
    telegram_user_id: i64,
    language: Language,
    action: &str,
) -> Result<Outcome, StatusCode> {
    let unknown = || Outcome::Alert(view::unknown_order_alert(language).to_owned());
    let Some((action, reference)) = action.split_once(':') else {
        return Ok(unknown());
    };

    if action == "cancel" {
        return Ok(
            match stop_order(state, telegram_user_id, reference).await? {
                Some(order) => {
                    state.sessions.clear(telegram_user_id);
                    Outcome::Replace(
                        view::payment_cancelled(chat_id, language, &order.reference).into(),
                    )
                }
                None => unknown(),
            },
        );
    }

    let Some(order) = fetch_order(state, telegram_user_id, reference).await? else {
        return Ok(unknown());
    };

    Ok(match action {
        "vnd" => Outcome::Replace(view::bank_transfer(
            chat_id,
            language,
            &state.config,
            &order,
        )),
        "usdt" => {
            Outcome::Replace(view::usdt_transfer(chat_id, language, &state.config, &order).into())
        }
        // A still-unpaid check answers in a popup so the QR panel it was tapped
        // from stays on screen.
        "check" if order.status() == OrderStatus::AwaitingPayment => {
            Outcome::Alert(view::pending_alert(language, &order))
        }
        "check" => Outcome::Replace(view::order_status(chat_id, language, &order).into()),
        _ => unknown(),
    })
}

async fn command_reply(
    state: &AppState,
    chat_id: i64,
    telegram_user_id: i64,
    username: Option<&str>,
    text: &str,
    language: Option<Language>,
) -> Result<Option<Reply>, StatusCode> {
    if !text.starts_with('/') {
        return Ok(None);
    }

    let owner = state.config.owners.includes(telegram_user_id, username);
    let command = text
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .split('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let chosen = language.unwrap_or(Language::Vietnamese);
    let reply: Reply = match command.as_str() {
        "/start" => match start_payload(text) {
            Some(slug) => match fetch_product(state, slug).await? {
                Some(product) if product.listed && product.is_available() => {
                    state
                        .sessions
                        .expect(telegram_user_id, Pending::Quantity(product.slug.clone()));
                    view::quantity_prompt(chat_id, chosen, &product).into()
                }
                _ => view::menu(chat_id, chosen, &fetch_catalogue(state).await?).into(),
            },
            None => view::start(chat_id, chosen).into(),
        },
        "/menu" => match language {
            Some(language) => view::menu(chat_id, language, &fetch_catalogue(state).await?).into(),
            None => view::language_picker(chat_id).into(),
        },
        "/lang" => view::language_picker(chat_id).into(),
        "/catalog" if owner => {
            let catalogue = fetch_full_catalogue(state).await?;
            view::admin_catalogue(chat_id, &catalogue).into()
        }
        "/catalog" => view::menu(chat_id, chosen, &fetch_catalogue(state).await?).into(),
        "/help" => view::help(chat_id, chosen).into(),
        "/orders" => {
            let orders = fetch_orders(state, telegram_user_id).await?;
            view::orders(chat_id, chosen, &orders).into()
        }
        "/status" => view::status(chat_id, chosen).into(),
        _ => return Ok(None),
    };

    Ok(Some(reply))
}

/// A plain message only means something while the chat is expecting one, and
/// what it means depends on which button was tapped last.
async fn pending_reply(
    state: &AppState,
    chat_id: i64,
    telegram_user_id: i64,
    username: Option<&str>,
    text: &str,
    language: Option<Language>,
) -> Result<Option<Reply>, StatusCode> {
    let Some(pending) = state.sessions.pending(telegram_user_id) else {
        return Ok(None);
    };
    let language = language.unwrap_or(Language::Vietnamese);

    // An owner expectation is re-checked here, not just when the button was
    // tapped, so losing owner status between the two stops the write.
    let owner = state.config.owners.includes(telegram_user_id, username);
    match pending {
        Pending::Quantity(slug) => {
            quantity_reply(state, chat_id, telegram_user_id, language, &slug, text).await
        }
        Pending::Restock(slug) if owner => restock_reply(state, chat_id, &slug, text).await,
        Pending::Price(slug) if owner => price_reply(state, chat_id, &slug, text).await,
        Pending::NewProduct if owner => {
            new_product_reply(state, chat_id, telegram_user_id, text).await
        }
        _ => Ok(None),
    }
}

async fn quantity_reply(
    state: &AppState,
    chat_id: i64,
    telegram_user_id: i64,
    language: Language,
    slug: &str,
    text: &str,
) -> Result<Option<Reply>, StatusCode> {
    let Some(product) = fetch_product(state, slug).await? else {
        return Ok(Some(view::unknown_order(chat_id, language).into()));
    };
    let Some(quantity) = quantity(text, &product) else {
        return Ok(Some(
            view::quantity_error(chat_id, language, &product).into(),
        ));
    };

    show_typing(state, chat_id).await;
    let Some(order) = create_order(state, telegram_user_id, chat_id, &product, quantity).await?
    else {
        return Ok(Some(view::unknown_order(chat_id, language).into()));
    };
    Ok(Some(
        view::payment_methods(chat_id, language, &order).into(),
    ))
}

async fn restock_reply(
    state: &AppState,
    chat_id: i64,
    slug: &str,
    text: &str,
) -> Result<Option<Reply>, StatusCode> {
    let Some(added) = counted(text) else {
        return Ok(Some(
            view::admin_result(chat_id, "⚠️ Gửi một số nguyên dương, ví dụ: 7").into(),
        ));
    };

    show_typing(state, chat_id).await;
    let Some(restock) = restock_product(state, slug, added).await? else {
        return Ok(Some(
            view::admin_result(chat_id, "⚠️ Không tìm thấy gói này.").into(),
        ));
    };

    announce_restock(state, restock.added, &restock.product).await;
    Ok(Some(view::admin_product(chat_id, &restock.product).into()))
}

async fn price_reply(
    state: &AppState,
    chat_id: i64,
    slug: &str,
    text: &str,
) -> Result<Option<Reply>, StatusCode> {
    let Some(price_vnd) = counted(text) else {
        return Ok(Some(
            view::admin_result(chat_id, "⚠️ Gửi giá bằng đồng, ví dụ: 135000").into(),
        ));
    };

    show_typing(state, chat_id).await;
    let Some(product) =
        adjust_product(state, slug, serde_json::json!({ "price_vnd": price_vnd })).await?
    else {
        return Ok(Some(
            view::admin_result(chat_id, "⚠️ Không tìm thấy gói này.").into(),
        ));
    };
    Ok(Some(view::admin_product(chat_id, &product).into()))
}

async fn new_product_reply(
    state: &AppState,
    chat_id: i64,
    telegram_user_id: i64,
    text: &str,
) -> Result<Option<Reply>, StatusCode> {
    let Some(draft) = product_draft(text) else {
        return Ok(Some(
            view::admin_result(
                chat_id,
                "⚠️ Thiếu thông tin. Cần ít nhất: nhà cung cấp, tên, bảo hành, giá.",
            )
            .into(),
        ));
    };

    show_typing(state, chat_id).await;
    let Some(product) = create_product(state, draft).await? else {
        return Ok(Some(
            view::admin_result(chat_id, "⚠️ Gói này đã tồn tại rồi.").into(),
        ));
    };

    // A product created with stock is stock arriving, so it is announced like
    // any other restock. Created empty, there is nothing to announce yet.
    if product.available > 0 {
        announce_restock(state, product.available, &product).await;
    }

    state.sessions.clear(telegram_user_id);
    Ok(Some(view::admin_product(chat_id, &product).into()))
}

/// Reads the filled-in template the owner sends back. Keys are matched loosely
/// so a stray accent or capital does not reject the whole block.
fn product_draft(text: &str) -> Option<serde_json::Value> {
    let mut draft = std::collections::HashMap::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if !value.is_empty() {
            draft.insert(normalize_key(key), value.to_owned());
        }
    }

    let provider = draft.get("nhacungcap").or_else(|| draft.get("provider"))?;
    let plan = draft.get("ten").or_else(|| draft.get("plan"))?;
    let warranty = draft.get("baohanh").or_else(|| draft.get("warranty"))?;
    let price_vnd = draft
        .get("gia")
        .or_else(|| draft.get("price"))
        .and_then(|value| counted(value))?;
    let available = draft
        .get("ton")
        .or_else(|| draft.get("stock"))
        .and_then(|value| counted(value))
        .unwrap_or(0);

    Some(serde_json::json!({
        "available": available,
        "category": draft.get("danhmuc").or_else(|| draft.get("category")),
        "detail": draft.get("chitiet").or_else(|| draft.get("detail")),
        "plan": plan,
        "price_vnd": price_vnd,
        "provider": provider,
        "variant": draft.get("bienthe").or_else(|| draft.get("variant")),
        "warranty": warranty,
    }))
}

fn normalize_key(key: &str) -> String {
    key.to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(|character| match character {
            'à' | 'á' | 'ả' | 'ã' | 'ạ' | 'â' | 'ầ' | 'ấ' | 'ẩ' | 'ẫ' | 'ậ' | 'ă' | 'ằ' | 'ắ'
            | 'ẳ' | 'ẵ' | 'ặ' => Some('a'),
            'è' | 'é' | 'ẻ' | 'ẽ' | 'ẹ' | 'ê' | 'ề' | 'ế' | 'ể' | 'ễ' | 'ệ' => {
                Some('e')
            }
            'ì' | 'í' | 'ỉ' | 'ĩ' | 'ị' => Some('i'),
            'ò' | 'ó' | 'ỏ' | 'õ' | 'ọ' | 'ô' | 'ồ' | 'ố' | 'ổ' | 'ỗ' | 'ộ' | 'ơ' | 'ờ' | 'ớ'
            | 'ở' | 'ỡ' | 'ợ' => Some('o'),
            'ù' | 'ú' | 'ủ' | 'ũ' | 'ụ' | 'ư' | 'ừ' | 'ứ' | 'ử' | 'ữ' | 'ự' => {
                Some('u')
            }
            'ỳ' | 'ý' | 'ỷ' | 'ỹ' | 'ỵ' => Some('y'),
            'đ' => Some('d'),
            other => Some(other),
        })
        .collect()
}

/// A count the owner typed, tolerating the separators a price is usually
/// written with.
fn counted(text: &str) -> Option<i64> {
    let digits: String = text
        .chars()
        .filter(|character| !matches!(character, ' ' | '.' | ',' | '_'))
        .collect();
    digits.parse::<i64>().ok().filter(|value| *value > 0)
}

/// `/start <payload>` is how Telegram delivers a deep link, which is what the
/// "Mua ngay" button on an announcement uses.
fn start_payload(text: &str) -> Option<&str> {
    text.split_whitespace().nth(1).filter(|payload| {
        !payload.is_empty()
            && payload.chars().all(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
            })
    })
}

fn quantity(text: &str, product: &Product) -> Option<i64> {
    text.trim()
        .parse::<i64>()
        .ok()
        .filter(|quantity| (1..=product.available).contains(quantity))
}

fn webhook_secret_matches(expected: &[u8], headers: &HeaderMap) -> bool {
    let received = headers
        .get(TELEGRAM_WEBHOOK_SECRET_HEADER)
        .map(HeaderValue::as_bytes)
        .unwrap_or_default();
    secrets_match(expected, received)
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

#[derive(Serialize)]
struct HealthResponse {
    service: &'static str,
    status: &'static str,
}

#[derive(Deserialize)]
struct TelegramContact {
    preferred_language: Option<String>,
}

#[derive(Deserialize)]
struct SepayResult {
    order: Option<Order>,
}

/// The announcement copy is Vietnamese only for now, so a contact's stored
/// language is read but not yet branched on.
#[derive(Deserialize)]
struct Audience {
    chat_id: i64,
}

#[derive(Deserialize)]
struct Restock {
    added: i64,
    product: Product,
}

/// SePay retries a webhook until it sees this acknowledgement.
#[derive(Serialize)]
struct SepayAcknowledgement {
    success: bool,
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use axum::{
        Json, Router,
        body::{Body, to_bytes},
        extract::{Path, State},
        http::{Request, Response, StatusCode},
        routing::{get, post, put},
    };
    use chrono::{TimeDelta, Utc};
    use reqwest::{Client, Url};
    use serde_json::{Value, json};
    use tokio::{net::TcpListener, task::JoinHandle};
    use tower::ServiceExt;

    use super::{AppState, router};
    use crate::{
        checkout::Sessions,
        config::{AppConfig, BankAccount, Owners, PaymentConfig},
    };

    fn owners() -> Owners {
        Owners {
            telegram_user_ids: Vec::new(),
            usernames: vec!["synasapmob".to_owned()],
        }
    }

    const REFERENCE: &str = "TESTREF00001";
    const UNKNOWN_ORDER_ALERT: &str =
        "⌛ Đơn này đã hết hạn hoặc không còn hiệu lực. Dùng /menu để tạo đơn mới.";

    #[test]
    fn callback_error_log_is_bounded() {
        assert_eq!(
            super::sanitize_telegram_error(&"x".repeat(300))
                .chars()
                .count(),
            256
        );
    }

    #[tokio::test]
    async fn webhook_rejects_a_missing_telegram_secret() {
        let response = router(test_state("http://127.0.0.1:1"))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/webhook")
                    .header("content-type", "application/json")
                    .body(Body::from(message_update("/start")))
                    .expect("valid webhook request"),
            )
            .await
            .expect("webhook should respond");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn first_menu_opens_the_language_picker() {
        let shop = Shop::open().await;
        let response = shop.update_json(message_update("/menu")).await;

        assert_eq!(response["method"], "sendMessage");
        assert_eq!(
            response["reply_markup"]["inline_keyboard"][0][0]["text"],
            "🇬🇧 English"
        );
    }

    #[tokio::test]
    async fn the_menu_lists_providers_and_nothing_else() {
        let shop = Shop::open().await;
        let response = shop.update_json(callback_update("language:vi")).await;
        let keyboard = response["reply_markup"]["inline_keyboard"]
            .as_array()
            .expect("a provider keyboard");

        assert_eq!(response["method"], "editMessageText");
        assert_eq!(response["text"], "Hub William shop\n\nChọn nhà cung cấp.");
        assert_eq!(keyboard.len(), 3);
        assert_eq!(keyboard[0][0]["text"], "ChatGPT");
        assert_eq!(keyboard[0][0]["callback_data"], "provider:chatgpt");
        assert_eq!(keyboard[1][0]["text"], "Claude");
        assert_eq!(keyboard[2][0]["text"], "Grok");
    }

    #[tokio::test]
    async fn a_provider_lists_its_packages_with_one_warranty_code_each() {
        let shop = Shop::open().await;
        let response = shop.update_json(callback_update("provider:claude")).await;
        let keyboard = response["reply_markup"]["inline_keyboard"]
            .as_array()
            .expect("a package keyboard");

        assert_eq!(response["method"], "editMessageText");
        assert_eq!(
            response["text"],
            "Claude\n\nChọn một gói để xem chi tiết.\nWF = bảo hành đầy đủ · W7D = bảo hành 7 ngày · NW = không bảo hành"
        );
        assert_eq!(
            keyboard[0][0]["text"],
            "🔥 Claude MAX X20 (Personal) · 1M (WF) --- 135,000đ (còn 53)"
        );
        assert_eq!(keyboard[0][0]["callback_data"], "catalog:claude-max-x20");
        assert_eq!(
            keyboard[1][0]["text"],
            "Claude MAX X5 (W7D) --- 79,000đ (còn 27)"
        );
        assert_eq!(keyboard[2][0]["callback_data"], "menu");
    }

    #[tokio::test]
    async fn a_sold_out_package_carries_no_callback() {
        let shop = Shop::open().await;
        let response = shop.update_json(callback_update("provider:grok")).await;
        let row = &response["reply_markup"]["inline_keyboard"][0][0];

        assert_eq!(
            row["text"],
            "Grok SuperGrok (Personal) (NW) --- 259,000đ (hết hàng)"
        );
        assert_eq!(row["style"], "danger");
        assert!(row["callback_data"].is_null());
    }

    #[tokio::test]
    async fn a_package_opens_a_quantity_prompt_that_returns_to_its_provider() {
        let shop = Shop::open().await;
        let response = shop
            .update_json(callback_update("catalog:claude-max-x20"))
            .await;

        assert_eq!(
            response["text"],
            "🔥 Claude MAX X20 (Personal) · 1M\n\n🔢 Nhập số lượng muốn mua\n\nTối đa: 53\nGửi một số, ví dụ: 1\n\n💵 Giá hiện tại: 135,000₫\n\n💰 Bảng giá:\n• 1+: 135,000₫\n\nActive trực tiếp trên tài khoản chính chủ của bạn."
        );
        assert_eq!(
            response["reply_markup"]["inline_keyboard"][0][0]["callback_data"],
            "provider:claude"
        );
    }

    #[tokio::test]
    async fn a_quantity_creates_an_order_and_offers_both_methods() {
        let shop = Shop::open().await;
        shop.update_json(callback_update("catalog:claude-max-x20"))
            .await;
        let response = shop.update_json(message_update("2")).await;
        let keyboard = &response["reply_markup"]["inline_keyboard"];

        assert_eq!(
            response["text"],
            "🧾 Đơn hàng\nClaude MAX X20 (Personal) · 1M\nSố lượng: 2 × 135,000₫\nTổng: 270,000₫\n\nPhương thức thanh toán:"
        );
        assert_eq!(keyboard[0][0]["text"], "💳 Chuyển Qua VND");
        assert_eq!(
            keyboard[0][0]["callback_data"],
            format!("pay:vnd:{REFERENCE}")
        );
        assert_eq!(keyboard[1][0]["text"], "₮ Chuyển Qua USDT");
        assert_eq!(shop.stored_order()["total_vnd"], 270_000);
    }

    #[tokio::test]
    async fn a_quantity_above_the_remaining_stock_is_refused() {
        let shop = Shop::open().await;
        shop.update_json(callback_update("catalog:claude-max-x20"))
            .await;
        let response = shop.update_json(message_update("54")).await;

        assert_eq!(
            response["text"],
            "⚠️ Số lượng không hợp lệ.\n\nGửi một số từ 1 đến 53."
        );
    }

    #[tokio::test]
    async fn a_number_without_a_selected_package_is_ignored() {
        let shop = Shop::open().await;
        let response = shop.send_update(message_update("2")).await;

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn the_vnd_method_renders_the_shop_qr_and_transfer_note() {
        let shop = Shop::open().await;
        shop.update_json(callback_update("catalog:claude-max-x20"))
            .await;
        shop.update_json(message_update("2")).await;
        let response = shop
            .update_json(callback_update(&format!("pay:vnd:{REFERENCE}")))
            .await;
        let caption = response["caption"].as_str().expect("a payment caption");

        assert_eq!(response["method"], "sendPhoto");
        assert_eq!(response["photo"], "https://shop.example.test/qr.png");
        assert!(caption.starts_with(
            "🏦 Thanh toán chuyển khoản\n\n🏛️ Ngân hàng: TECHCOMBANK\n👤 Chủ TK: TRAN VAN SON\n💳 Số TK: 19036951867026\n💰 Số tiền: 270,000₫\n📝 Nội dung CK: CAM TIEN DI CHILL THOI TESTREF00001\n"
        ));
        assert!(caption.ends_with(
            "\n\n👆 Quét mã QR phía trên, rồi tự nhập số tiền và nội dung CK ở trên.\n✅ Đơn hàng xử lý tự động sau khi thanh toán."
        ));
        assert_eq!(
            response["reply_markup"]["inline_keyboard"][0][0]["text"],
            "🔄 Kiểm tra thanh toán"
        );
    }

    #[tokio::test]
    async fn the_qr_route_serves_a_png() {
        let shop = Shop::open().await;
        let response = shop.get("/qr.png").await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "image/png");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..4], b"\x89PNG");
    }

    #[tokio::test]
    async fn an_unpaid_check_answers_in_a_popup_without_touching_the_chat() {
        let shop = Shop::open().await;
        shop.update_json(callback_update("catalog:claude-max-x20"))
            .await;
        shop.update_json(message_update("2")).await;
        shop.forget_deletions();

        let response = shop
            .send_update(callback_update(&format!("pay:check:{REFERENCE}")))
            .await;

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            shop.last_alert().expect("a popup"),
            format!(
                "⏳ Chưa nhận được giao dịch cho đơn {REFERENCE}. Chuyển khoản thường về trong vòng 1 phút — chờ chút rồi bấm kiểm tra lại."
            )
        );
        assert!(shop.deleted_message_ids().is_empty());
    }

    #[tokio::test]
    async fn a_settled_check_replaces_the_panel_it_was_tapped_from() {
        let shop = Shop::open().await;
        shop.update_json(callback_update("catalog:claude-max-x20"))
            .await;
        shop.update_json(message_update("2")).await;
        shop.settle_order();
        shop.forget_deletions();

        let response = shop
            .update_json(callback_update(&format!("pay:check:{REFERENCE}")))
            .await;
        let text = response["text"].as_str().expect("a status message");

        assert!(text.starts_with(&format!("✅ Đã nhận thanh toán cho đơn {REFERENCE}.")));
        assert_eq!(shop.deleted_message_ids(), [7]);
    }

    #[tokio::test]
    async fn stopping_an_order_retires_its_reference() {
        let shop = Shop::open().await;
        shop.update_json(callback_update("catalog:claude-max-x20"))
            .await;
        shop.update_json(message_update("2")).await;
        shop.forget_deletions();

        let stopped = shop
            .update_json(callback_update(&format!("pay:cancel:{REFERENCE}")))
            .await;
        assert_eq!(
            stopped["text"],
            format!("✖️ Đã dừng thanh toán cho đơn {REFERENCE}.\n\nDùng /menu để chọn gói khác.")
        );
        assert_eq!(shop.deleted_message_ids(), [7]);

        let replayed = shop
            .send_update(callback_update(&format!("pay:cancel:{REFERENCE}")))
            .await;
        assert_eq!(replayed.status(), StatusCode::NO_CONTENT);
        assert_eq!(shop.last_alert().expect("a popup"), UNKNOWN_ORDER_ALERT);
    }

    #[tokio::test]
    async fn an_unknown_reference_never_reaches_a_payment_panel() {
        let shop = Shop::open().await;
        let response = shop
            .send_update(callback_update("pay:vnd:NOSUCHREF001"))
            .await;

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(shop.last_alert().expect("a popup"), UNKNOWN_ORDER_ALERT);
    }

    /// Browsing rewrites one message rather than stacking or re-sending it, so
    /// the shop never moves to the end of the chat under the buyer.
    #[tokio::test]
    async fn browsing_the_catalogue_rewrites_one_message() {
        let shop = Shop::open().await;

        for data in ["provider:claude", "catalog:claude-max-x20", "menu"] {
            let response = shop.update_json(callback_update(data)).await;
            assert_eq!(response["method"], "editMessageText", "{data}");
            assert_eq!(response["message_id"], 7, "{data}");
        }

        assert!(shop.deleted_message_ids().is_empty());
        assert!(
            shop.last_alert().is_none(),
            "navigation should not raise a popup"
        );
    }

    /// `/catalog` is one command with two faces: the stock room for the owner,
    /// the ordinary shop for everyone else.
    #[tokio::test]
    async fn catalog_opens_the_stock_room_only_for_an_owner() {
        let shop = Shop::open().await;

        let owner = shop.update_json(owner_message("/catalog")).await;
        let text = owner["text"].as_str().expect("a stock room");
        assert!(text.starts_with("🛠 Quản lý kho"));
        assert_eq!(
            owner["reply_markup"]["inline_keyboard"][0][0]["callback_data"],
            "admin:open:chatgpt-plus"
        );

        let buyer = shop.update_json(message_update("/catalog")).await;
        assert_eq!(buyer["text"], "Hub William shop\n\nChọn nhà cung cấp.");
    }

    #[tokio::test]
    async fn an_admin_button_does_nothing_for_a_stranger() {
        let shop = Shop::open().await;
        let response = shop
            .send_update(callback_update("admin:open:claude-max-x20"))
            .await;

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(shop.last_alert().is_none());
    }

    #[tokio::test]
    async fn an_owner_adds_stock_and_the_channel_hears_about_it() {
        let shop = Shop::open().await;
        shop.update_json(owner_callback("admin:restock:claude-max-x20"))
            .await;

        let response = shop.update_json(owner_message("7")).await;
        let text = response["text"].as_str().expect("the product panel");

        assert!(text.starts_with("🛠 Claude MAX X20 (Personal) · 1M"));
        assert!(text.contains("📦 Tồn kho: 60"));

        let posted = shop.api.notified.lock().unwrap().clone();
        let announcement = posted.last().expect("a channel announcement");
        assert_eq!(announcement["chat_id"], "@hubwilliam");
        assert_eq!(
            announcement["text"],
            "🔥 Claude có hàng mới\n🛍️ Claude MAX X20 (Personal) · 1M (WF)\n📁 Danh mục: AI Tools\n💰 Giá: 135,000₫\n📦 Tồn kho: 60 · vừa nhập 7\n\n👇 Bấm nút bên dưới để mua ngay:"
        );
        assert_eq!(
            announcement["reply_markup"]["inline_keyboard"][0][0]["url"],
            "https://t.me/hub_william_bot?start=claude-max-x20"
        );
    }

    #[tokio::test]
    async fn an_owner_changes_a_price_and_the_shop_follows() {
        let shop = Shop::open().await;
        shop.update_json(owner_callback("admin:price:claude-max-x20"))
            .await;
        shop.update_json(owner_message("150.000")).await;

        let response = shop.update_json(callback_update("provider:claude")).await;
        assert_eq!(
            response["reply_markup"]["inline_keyboard"][0][0]["text"],
            "🔥 Claude MAX X20 (Personal) · 1M (WF) --- 150,000đ (còn 53)"
        );
    }

    #[tokio::test]
    async fn hiding_a_product_takes_it_out_of_the_shop_but_not_the_stock_room() {
        let shop = Shop::open().await;
        shop.update_json(owner_callback("admin:listed:claude-max-x5"))
            .await;

        let shopper = shop.update_json(callback_update("provider:claude")).await;
        let rows = shopper["reply_markup"]["inline_keyboard"]
            .as_array()
            .expect("a package keyboard");
        assert_eq!(rows.len(), 2, "one package plus the back button");

        let owner = shop.update_json(owner_message("/catalog")).await;
        assert!(
            owner["text"]
                .as_str()
                .expect("a stock room")
                .contains("🙈 Claude MAX X5")
        );
    }

    #[tokio::test]
    async fn an_owner_creates_a_product_from_the_template() {
        let shop = Shop::open().await;
        shop.update_json(owner_callback("admin:new")).await;

        let response = shop
            .update_json(owner_message(
                r"nhà cung cấp: Capcut\ntên: Pro 30D\nbảo hành: W7D\ngiá: 50000\ntồn: 7",
            ))
            .await;

        let text = response["text"].as_str().expect("the new product panel");
        assert!(text.starts_with("🛠 Capcut Pro 30D"));
        assert!(text.contains("💰 Giá: 50,000₫"));
        assert!(text.contains("📦 Tồn kho: 7"));
    }

    /// The deep link an announcement carries has to land on that product.
    /// A product created with stock is stock arriving, so the channel hears
    /// about it the same way a restock is announced.
    #[tokio::test]
    async fn creating_a_stocked_product_announces_it() {
        let shop = Shop::open().await;
        shop.update_json(owner_callback("admin:new")).await;
        shop.update_json(owner_message(
            r"nhà cung cấp: Capcut\ntên: Pro 30D\nbảo hành: W7D\ngiá: 50000\ntồn: 7",
        ))
        .await;

        let posted = shop.api.notified.lock().unwrap().clone();
        let announcement = posted.last().expect("a channel announcement");

        assert_eq!(announcement["chat_id"], "@hubwilliam");
        assert_eq!(
            announcement["text"],
            "🔥 Capcut có hàng mới\n🛍️ Capcut Pro 30D (W7D)\n💰 Giá: 50,000₫\n📦 Tồn kho: 7 · vừa nhập 7\n\n👇 Bấm nút bên dưới để mua ngay:"
        );
        assert_eq!(
            announcement["reply_markup"]["inline_keyboard"][0][0]["url"],
            "https://t.me/hub_william_bot?start=capcut-pro-30d"
        );
    }

    /// The announcement also reaches everyone who has started the bot, not only
    /// the channel, and it carries the same deep link.
    #[tokio::test]
    async fn a_restock_reaches_the_bot_chats_as_well_as_the_channel() {
        let shop = Shop::open().await;
        shop.update_json(owner_callback("admin:restock:claude-max-x20"))
            .await;
        shop.update_json(owner_message("7")).await;

        // The fan-out is detached, so give it a moment to drain.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let posted = shop.api.notified.lock().unwrap().clone();

        let channel = posted
            .iter()
            .find(|message| message["chat_id"] == "@hubwilliam")
            .expect("a channel post");
        let buyer = posted
            .iter()
            .find(|message| message["chat_id"] == 555)
            .expect("a message to the contact");

        assert_eq!(channel["text"], buyer["text"]);
        assert!(
            buyer["text"]
                .as_str()
                .expect("announcement text")
                .starts_with("🔥 Claude có hàng mới")
        );
        assert_eq!(
            buyer["reply_markup"]["inline_keyboard"][0][0]["url"],
            "https://t.me/hub_william_bot?start=claude-max-x20"
        );
    }

    /// Stock held by an open order is not sellable, which is what stops two
    /// buyers from taking the same unit.
    #[tokio::test]
    async fn the_owner_panel_separates_stock_on_hand_from_stock_held() {
        let shop = Shop::open().await;
        shop.reserve("claude-max-x20", 50);

        let response = shop
            .update_json(owner_callback("admin:open:claude-max-x20"))
            .await;
        let text = response["text"].as_str().expect("the product panel");

        assert!(text.contains("📦 Tồn kho: 53 · đang giữ 50 · bán được 3"));
    }

    #[tokio::test]
    async fn a_start_payload_opens_the_product_it_names() {
        let shop = Shop::open().await;
        let response = shop
            .update_json(message_update("/start claude-max-x20"))
            .await;

        assert!(
            response["text"]
                .as_str()
                .expect("a quantity prompt")
                .starts_with("🔥 Claude MAX X20 (Personal) · 1M\n\n🔢")
        );
    }

    #[tokio::test]
    async fn an_unknown_start_payload_falls_back_to_the_shop() {
        let shop = Shop::open().await;
        let response = shop
            .update_json(message_update("/start no-such-thing"))
            .await;

        assert_eq!(response["text"], "Hub William shop\n\nChọn nhà cung cấp.");
    }

    #[tokio::test]
    async fn the_orders_command_lists_what_the_api_holds() {
        let shop = Shop::open().await;
        shop.update_json(callback_update("catalog:claude-max-x20"))
            .await;
        shop.update_json(message_update("2")).await;
        let response = shop.update_json(message_update("/orders")).await;

        assert_eq!(
            response["text"],
            format!(
                "🧾 Đơn hàng gần nhất của bạn\n\n⏳ {REFERENCE} — Claude MAX X20 (Personal) · 1M × 2 — 270,000₫"
            )
        );
    }

    #[tokio::test]
    async fn sepay_refuses_a_call_without_the_configured_api_key() {
        let shop = Shop::open().await;

        assert_eq!(
            shop.post_sepay(Some("Apikey wrong-key")).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(shop.post_sepay(None).await, StatusCode::UNAUTHORIZED);
        assert_eq!(
            shop.post_sepay(Some("sepay-secret")).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn sepay_records_a_transfer_and_tells_the_buyer() {
        let shop = Shop::open().await;
        shop.update_json(callback_update("catalog:claude-max-x20"))
            .await;
        shop.update_json(message_update("2")).await;

        assert_eq!(
            shop.post_sepay(Some("Apikey sepay-secret")).await,
            StatusCode::OK
        );

        let notified = shop.api.notified.lock().unwrap().clone();
        assert_eq!(notified.len(), 1);
        assert_eq!(notified[0]["chat_id"], 123);
        assert_eq!(notified[0]["method"], "sendMessage");
        let text = notified[0]["text"].as_str().expect("a notification");
        assert!(text.starts_with(&format!("✅ Đã nhận thanh toán cho đơn {REFERENCE}.")));
    }

    struct Shop {
        api: FakeApi,
        state: AppState,
        task: JoinHandle<()>,
    }

    impl Drop for Shop {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl Shop {
        async fn open() -> Self {
            let (api, url, task) = fake_api().await;
            Self {
                api,
                state: test_state(&url),
                task,
            }
        }

        async fn update_json(&self, body: String) -> Value {
            let response = self.send_update(body).await;

            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("response body should be readable");
            serde_json::from_slice(&body).expect("response should be Telegram API JSON")
        }

        async fn get(&self, path: &str) -> Response<Body> {
            router(self.state.clone())
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .body(Body::empty())
                        .expect("valid request"),
                )
                .await
                .expect("the route should respond")
        }

        async fn send_update(&self, body: String) -> Response<Body> {
            router(self.state.clone())
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/webhook")
                        .header("content-type", "application/json")
                        .header("x-telegram-bot-api-secret-token", "telegram-secret")
                        .body(Body::from(body))
                        .expect("valid webhook request"),
                )
                .await
                .expect("webhook should respond")
        }

        async fn post_sepay(&self, authorization: Option<&str>) -> StatusCode {
            let mut request = Request::builder()
                .method("POST")
                .uri("/sepay")
                .header("content-type", "application/json");
            if let Some(authorization) = authorization {
                request = request.header("authorization", authorization);
            }
            let body = json!({
                "id": 92_704,
                "gateway": "Techcombank",
                "transactionDate": "2026-09-10 15:31:00",
                "accountNumber": "19036951867026",
                "content": format!("CAM TIEN DI CHILL THOI {REFERENCE}"),
                "transferType": "in",
                "transferAmount": 270_000,
                "referenceCode": "TCB.327",
            });

            router(self.state.clone())
                .oneshot(
                    request
                        .body(Body::from(body.to_string()))
                        .expect("valid SePay request"),
                )
                .await
                .expect("the SePay route should respond")
                .status()
        }

        /// The popup Telegram was told to show for the most recent tap, if any.
        fn last_alert(&self) -> Option<String> {
            let alerts = self.api.alerts.lock().unwrap();
            let last = alerts.last()?;
            // A silent acknowledgement omits both keys. Sending `text: null`
            // instead makes Telegram float the word "null" at the buyer.
            assert_eq!(last.get("show_alert").is_some(), last.get("text").is_some());
            assert!(
                last.get("text").is_none_or(serde_json::Value::is_string),
                "a notice must be a string, never null"
            );
            Some(last["text"].as_str()?.to_owned())
        }

        fn deleted_message_ids(&self) -> Vec<i64> {
            self.api
                .deleted
                .lock()
                .unwrap()
                .iter()
                .filter_map(|call| call["message_id"].as_i64())
                .collect()
        }

        /// Forgets the removals a test's setup caused, so an assertion can talk
        /// about the one tap it is actually about.
        fn forget_deletions(&self) {
            self.api.deleted.lock().unwrap().clear();
        }

        /// Mirrors the API holding stock behind an order awaiting payment.
        fn reserve(&self, slug: &str, quantity: i64) {
            let mut products = self.api.products.lock().unwrap();
            let product = products
                .iter_mut()
                .find(|product| product["slug"] == slug)
                .expect("a seeded product");
            let on_hand = product["on_hand"].as_i64().unwrap_or_default();
            product["reserved"] = json!(quantity);
            product["available"] = json!((on_hand - quantity).max(0));
        }

        fn stored_order(&self) -> Value {
            self.api
                .orders
                .lock()
                .unwrap()
                .get(REFERENCE)
                .cloned()
                .expect("an order created through the API")
        }

        fn settle_order(&self) {
            let mut orders = self.api.orders.lock().unwrap();
            let order = orders.get_mut(REFERENCE).expect("an order");
            order["status"] = json!("paid");
            order["paid_at"] = json!(Utc::now());
        }
    }

    /// A stand-in for `apps/api` that keeps orders in memory, so the adapter is
    /// exercised over real HTTP against the contract it actually calls.
    #[derive(Clone, Default)]
    struct FakeApi {
        alerts: Arc<Mutex<Vec<Value>>>,
        audience: Arc<Mutex<Vec<Value>>>,
        deleted: Arc<Mutex<Vec<Value>>>,
        notified: Arc<Mutex<Vec<Value>>>,
        orders: Arc<Mutex<HashMap<String, Value>>>,
        products: Arc<Mutex<Vec<Value>>>,
    }

    fn seeded_products() -> Vec<Value> {
        vec![
            json!({
                "available": 12, "category": "AI Tools", "detail": null, "on_hand": 12, "reserved": 0, "hot": true, "listed": true,
                "plan": "Plus", "price_vnd": 299_000, "provider_name": "ChatGPT",
                "provider_slug": "chatgpt", "slug": "chatgpt-plus", "variant": "Personal",
                "warranty": "W7D", "warranty_note_en": "login check",
                "warranty_note_vi": "Bảo hành login check 1 tiếng"
            }),
            json!({
                "available": 53, "category": "AI Tools", "detail": "1M", "on_hand": 53, "reserved": 0, "hot": true, "listed": true,
                "plan": "MAX X20", "price_vnd": 135_000, "provider_name": "Claude",
                "provider_slug": "claude", "slug": "claude-max-x20", "variant": "Personal",
                "warranty": "WF", "warranty_note_en": "own account",
                "warranty_note_vi": "Active trực tiếp trên tài khoản chính chủ của bạn."
            }),
            json!({
                "available": 27, "category": "AI Tools", "detail": null, "on_hand": 27, "reserved": 0, "hot": false, "listed": true,
                "plan": "MAX X5", "price_vnd": 79_000, "provider_name": "Claude",
                "provider_slug": "claude", "slug": "claude-max-x5", "variant": null,
                "warranty": "W7D", "warranty_note_en": "login check",
                "warranty_note_vi": "Bảo hành login check 1 tiếng"
            }),
            json!({
                "available": 0, "category": "AI Tools", "detail": null, "on_hand": 0, "reserved": 0, "hot": false, "listed": true,
                "plan": "SuperGrok", "price_vnd": 259_000, "provider_name": "Grok",
                "provider_slug": "grok", "slug": "grok-supergrok", "variant": "Personal",
                "warranty": "NW", "warranty_note_en": "login check",
                "warranty_note_vi": "Bảo hành login check 1 tiếng"
            }),
        ]
    }

    /// Mirrors the API's grouping, which the adapter relies on for its menu.
    fn catalogue_of(products: &[Value], listed_only: bool) -> Value {
        let mut providers: Vec<Value> = Vec::new();
        for product in products {
            if listed_only && product["listed"] != true {
                continue;
            }
            match providers
                .iter_mut()
                .find(|provider| provider["slug"] == product["provider_slug"])
            {
                Some(provider) => provider["products"]
                    .as_array_mut()
                    .expect("a provider carries products")
                    .push(product.clone()),
                None => providers.push(json!({
                    "name": product["provider_name"],
                    "products": [product.clone()],
                    "slug": product["provider_slug"],
                })),
            }
        }
        json!({ "providers": providers })
    }

    fn test_state(api_url: &str) -> AppState {
        AppState {
            config: AppConfig {
                api_internal_url: Url::parse(api_url).expect("test API URL should parse"),
                api_service_token: "api-service-secret".to_owned(),
                bot_token: "bot-token".to_owned(),
                announce_chat_id: Some("@hubwilliam".to_owned()),
                bot_username: Some("hub_william_bot".to_owned()),
                owners: owners(),
                payment: PaymentConfig {
                    bank: Some(BankAccount {
                        holder: "TRAN VAN SON".to_owned(),
                        name: "TECHCOMBANK".to_owned(),
                        number: "19036951867026".to_owned(),
                    }),
                    memo_prefix: "CAM TIEN DI CHILL THOI".to_owned(),
                    usdt: None,
                },
                public_url: Some(Url::parse("https://shop.example.test").expect("valid origin")),
                sepay_api_key: Some("sepay-secret".to_owned()),
                telegram_api_base_url: Url::parse(api_url).expect("test API URL should parse"),
                webhook_secret: b"telegram-secret".to_vec(),
            },
            http: Client::new(),
            sessions: Sessions::default(),
        }
    }

    async fn fake_api() -> (FakeApi, String, JoinHandle<()>) {
        let api = FakeApi::default();
        *api.products.lock().unwrap() = seeded_products();
        *api.audience.lock().unwrap() = vec![json!({ "chat_id": 555 })];
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test API listener should bind");
        let address = listener
            .local_addr()
            .expect("test API listener should have an address");
        let app = Router::new()
            .route(
                "/internal/telegram/contacts",
                post(|| async { Json(json!({"preferred_language": null})) }),
            )
            .route(
                "/internal/telegram/contacts/{telegram_user_id}",
                get(|| async { Json(json!({"preferred_language": "vi"})) }),
            )
            .route(
                "/internal/telegram/contacts/{telegram_user_id}/language",
                put(|| async { Json(json!({"preferred_language": "vi"})) }),
            )
            .route(
                "/internal/telegram/contacts/{telegram_user_id}/orders",
                get(list_orders).post(create_order),
            )
            .route(
                "/internal/telegram/contacts/{telegram_user_id}/orders/{reference}",
                get(get_order),
            )
            .route(
                "/internal/telegram/contacts/{telegram_user_id}/orders/{reference}/cancel",
                post(cancel_order),
            )
            .route("/internal/telegram/payments/sepay", post(record_payment))
            .route("/internal/telegram/audience", get(audience))
            .route(
                "/internal/telegram/audience/{chat_id}/block",
                post(|| async { Json(json!({"preferred_language": null})) }),
            )
            .route("/internal/telegram/catalogue", get(listed_catalogue))
            .route("/internal/telegram/catalogue/full", get(every_product))
            .route("/internal/telegram/products", post(add_product))
            .route(
                "/internal/telegram/products/{slug}",
                get(read_product).patch(change_product),
            )
            .route(
                "/internal/telegram/products/{slug}/restock",
                post(add_stock),
            )
            .route("/botbot-token/answerCallbackQuery", post(answer_callback))
            .route("/botbot-token/deleteMessage", post(delete_message))
            .route(
                "/botbot-token/sendChatAction",
                post(|| async { Json(json!({"ok": true, "result": true})) }),
            )
            .route("/botbot-token/sendMessage", post(send_message))
            .with_state(api.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("test API server should not fail");
        });

        (api, format!("http://{address}"), task)
    }

    fn title_of(product: &Value) -> String {
        let mut title = format!(
            "{} {}",
            product["provider_name"].as_str().unwrap_or_default(),
            product["plan"].as_str().unwrap_or_default()
        );
        if let Some(variant) = product["variant"].as_str() {
            title.push_str(&format!(" ({variant})"));
        }
        if let Some(detail) = product["detail"].as_str() {
            title.push_str(&format!(" · {detail}"));
        }
        title
    }

    async fn create_order(
        State(api): State<FakeApi>,
        Path(telegram_user_id): Path<i64>,
        Json(payload): Json<Value>,
    ) -> Result<Json<Value>, StatusCode> {
        let slug = payload["product"].as_str().unwrap_or_default().to_owned();
        let product = api
            .products
            .lock()
            .unwrap()
            .iter()
            .find(|product| product["slug"] == slug)
            .cloned()
            .ok_or(StatusCode::NOT_FOUND)?;
        let quantity = payload["quantity"].as_i64().unwrap_or(1);
        let unit_price_vnd = product["price_vnd"].as_i64().unwrap_or_default();
        let order = json!({
            "chat_id": payload["chat_id"],
            "expires_at": Utc::now() + TimeDelta::minutes(15),
            "item_id": slug,
            "item_title": title_of(&product),
            "paid_at": Value::Null,
            "quantity": quantity,
            "reference": REFERENCE,
            "status": "awaiting_payment",
            "telegram_user_id": telegram_user_id,
            "total_vnd": unit_price_vnd * quantity,
            "unit_price_vnd": unit_price_vnd,
        });
        api.orders
            .lock()
            .unwrap()
            .insert(REFERENCE.to_owned(), order.clone());
        Ok(Json(order))
    }

    async fn get_order(
        State(api): State<FakeApi>,
        Path((_telegram_user_id, reference)): Path<(i64, String)>,
    ) -> Result<Json<Value>, StatusCode> {
        api.orders
            .lock()
            .unwrap()
            .get(&reference)
            .cloned()
            .map(Json)
            .ok_or(StatusCode::NOT_FOUND)
    }

    async fn list_orders(State(api): State<FakeApi>) -> Json<Value> {
        Json(Value::Array(
            api.orders.lock().unwrap().values().cloned().collect(),
        ))
    }

    async fn cancel_order(
        State(api): State<FakeApi>,
        Path((_telegram_user_id, reference)): Path<(i64, String)>,
    ) -> Result<Json<Value>, StatusCode> {
        let mut orders = api.orders.lock().unwrap();
        let order = orders.get_mut(&reference).ok_or(StatusCode::NOT_FOUND)?;
        if order["status"] != "awaiting_payment" {
            return Err(StatusCode::NOT_FOUND);
        }
        order["status"] = json!("cancelled");
        Ok(Json(order.clone()))
    }

    async fn record_payment(State(api): State<FakeApi>, Json(_body): Json<Value>) -> Json<Value> {
        let mut orders = api.orders.lock().unwrap();
        let Some(order) = orders.get_mut(REFERENCE) else {
            return Json(json!({"duplicate": false, "order": Value::Null}));
        };
        order["status"] = json!("paid");
        order["paid_at"] = json!(Utc::now());
        Json(json!({"duplicate": false, "order": order.clone()}))
    }

    async fn send_message(State(api): State<FakeApi>, Json(body): Json<Value>) -> Json<Value> {
        api.notified.lock().unwrap().push(body);
        Json(json!({"ok": true, "result": {}}))
    }

    async fn audience(State(api): State<FakeApi>) -> Json<Value> {
        Json(Value::Array(api.audience.lock().unwrap().clone()))
    }

    async fn listed_catalogue(State(api): State<FakeApi>) -> Json<Value> {
        Json(catalogue_of(&api.products.lock().unwrap(), true))
    }

    async fn every_product(State(api): State<FakeApi>) -> Json<Value> {
        Json(catalogue_of(&api.products.lock().unwrap(), false))
    }

    async fn read_product(
        State(api): State<FakeApi>,
        Path(slug): Path<String>,
    ) -> Result<Json<Value>, StatusCode> {
        api.products
            .lock()
            .unwrap()
            .iter()
            .find(|product| product["slug"] == slug)
            .cloned()
            .map(Json)
            .ok_or(StatusCode::NOT_FOUND)
    }

    async fn add_stock(
        State(api): State<FakeApi>,
        Path(slug): Path<String>,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, StatusCode> {
        let added = body["added"].as_i64().ok_or(StatusCode::NOT_FOUND)?;
        let mut products = api.products.lock().unwrap();
        let product = products
            .iter_mut()
            .find(|product| product["slug"] == slug)
            .ok_or(StatusCode::NOT_FOUND)?;
        product["available"] = json!(product["available"].as_i64().unwrap_or_default() + added);
        product["on_hand"] = json!(product["on_hand"].as_i64().unwrap_or_default() + added);
        Ok(Json(json!({ "added": added, "product": product.clone() })))
    }

    async fn change_product(
        State(api): State<FakeApi>,
        Path(slug): Path<String>,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, StatusCode> {
        let mut products = api.products.lock().unwrap();
        let product = products
            .iter_mut()
            .find(|product| product["slug"] == slug)
            .ok_or(StatusCode::NOT_FOUND)?;
        for key in ["hot", "listed", "price_vnd"] {
            if !body[key].is_null() {
                product[key] = body[key].clone();
            }
        }
        Ok(Json(product.clone()))
    }

    async fn add_product(State(api): State<FakeApi>, Json(body): Json<Value>) -> Json<Value> {
        let product = json!({
            "available": body["available"],
            "category": body["category"],
            "detail": body["detail"],
            "on_hand": body["available"],
            "reserved": 0,
            "hot": false,
            "listed": true,
            "plan": body["plan"],
            "price_vnd": body["price_vnd"],
            "provider_name": body["provider"],
            "provider_slug": "capcut",
            "slug": "capcut-pro-30d",
            "variant": body["variant"],
            "warranty": body["warranty"],
            "warranty_note_en": "login check",
            "warranty_note_vi": "Bảo hành login check 1 tiếng",
        });
        api.products.lock().unwrap().push(product.clone());
        Json(product)
    }

    async fn answer_callback(State(api): State<FakeApi>, Json(body): Json<Value>) -> Json<Value> {
        api.alerts.lock().unwrap().push(body);
        Json(json!({"ok": true, "result": true}))
    }

    async fn delete_message(State(api): State<FakeApi>, Json(body): Json<Value>) -> Json<Value> {
        api.deleted.lock().unwrap().push(body);
        Json(json!({"ok": true, "result": true}))
    }

    fn message_update(text: &str) -> String {
        format!(
            r#"{{
              "update_id": 1,
              "message": {{
                "chat": {{"id": 123, "type": "private"}},
                "from": {{"id": 456, "is_bot": false, "first_name": "William"}},
                "text": "{text}"
              }}
            }}"#
        )
    }

    fn owner_message(text: &str) -> String {
        message_update(text).replace(
            r#""first_name": "William""#,
            r#""first_name": "William", "username": "SynasapMob""#,
        )
    }

    fn owner_callback(data: &str) -> String {
        callback_update(data).replace(
            r#""first_name": "William""#,
            r#""first_name": "William", "username": "SynasapMob""#,
        )
    }

    fn callback_update(data: &str) -> String {
        format!(
            r#"{{
              "update_id": 2,
              "callback_query": {{
                "id": "callback-id",
                "from": {{"id": 456, "is_bot": false, "first_name": "William"}},
                "message": {{"message_id": 7, "chat": {{"id": 123, "type": "private"}}}},
                "data": "{data}"
              }}
            }}"#
        )
    }
}
