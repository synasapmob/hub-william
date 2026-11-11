//! The dashboard asks the bot to send things. The bot's token lives in
//! `apps/telegram`, so the API does not hold it: it asks the adapter over HTTP,
//! with the same shared secret the adapter uses to call the API.

use std::time::Duration;

use axum::{Json, extract::State};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    api::telegram::catalogue::normalize_slug,
    core::{ApiError, AppState},
};

use super::access::{Permission, authorize};

const SERVICE_TOKEN_HEADER: &str = "x-hub-william-telegram-token";
const ADAPTER_TIMEOUT: Duration = Duration::from_secs(15);

/// Telegram refuses a message longer than this.
pub(crate) const MAXIMUM_MESSAGE_CHARACTERS: usize = 4096;

const NOT_CONNECTED: &str = "The dashboard is not connected to the Telegram bot.";

/// Posts to the adapter, or says why it cannot. No address or no secret means
/// the shop has not connected the bot; a request that fails means it did not
/// answer. Neither is the caller's mistake.
pub(crate) async fn call_adapter<Body: Serialize>(
    state: &AppState,
    path: &str,
    body: &Body,
) -> Result<reqwest::Response, ApiError> {
    let url = state
        .config
        .telegram_adapter_url
        .as_ref()
        .ok_or(ApiError::NotAvailable(NOT_CONNECTED))?;
    let token = state
        .config
        .telegram_key()
        .ok_or(ApiError::NotAvailable(NOT_CONNECTED))?;
    let endpoint = url.join(path).map_err(|_| ApiError::Internal)?;

    state
        .http
        .post(endpoint)
        .header(SERVICE_TOKEN_HEADER, token)
        .timeout(ADAPTER_TIMEOUT)
        .json(body)
        .send()
        .await
        .map_err(|error| {
            eprintln!(
                "telegram adapter request to {path} failed: {}",
                error.without_url()
            );
            ApiError::Provider("The Telegram bot did not answer.".to_owned())
        })
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct Announcement {
    /// Plain text, up to 4,096 characters. The bot sends it as it is.
    pub text: String,
    /// The slug of a package. Naming one adds a "Mua ngay" button that opens
    /// that package in the bot; without it the message goes out bare.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct Announced {
    /// Whether the channel got it. False when no channel is set, or it refused.
    pub channel: bool,
    /// How many chats the bot is sending it to. They are sent one by one, at a
    /// pace Telegram allows, so this is how many it has started on.
    pub audience: i64,
}

#[utoipa::path(
    post,
    path = "/dashboard/telegram/announcements",
    request_body = Announcement,
    responses(
        (status = 200, description = "The bot posted it to the channel and started sending it to everyone who can be reached", body = Announced),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 422, description = "The message is empty or longer than 4096 characters, or the package is not a slug", body = crate::core::ErrorResponse),
        (status = 501, description = "The dashboard is not connected to the bot", body = crate::core::ErrorResponse),
        (status = 502, description = "The bot did not answer", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn announce(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<Announcement>,
) -> Result<Json<Announced>, ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;

    let text = body.text.trim();
    if text.is_empty() {
        return Err(ApiError::Validation("A message cannot be empty."));
    }
    if text.chars().count() > MAXIMUM_MESSAGE_CHARACTERS {
        return Err(ApiError::Validation(
            "A Telegram message is at most 4096 characters.",
        ));
    }

    let product = body.product.as_deref().map(normalize_slug).transpose()?;

    let response = call_adapter(
        &state,
        "/internal/announce",
        &Announcement {
            product,
            text: text.to_owned(),
        },
    )
    .await?;
    let status = response.status();

    if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
        return Err(ApiError::Validation(
            "The Telegram bot refused that message.",
        ));
    }
    if !status.is_success() {
        eprintln!("telegram adapter answered the announcement with {status}");
        return Err(ApiError::Provider(
            "The Telegram bot could not send the message.".to_owned(),
        ));
    }

    response.json().await.map(Json).map_err(|error| {
        eprintln!("telegram adapter sent an announcement answer that was not understood: {error}");
        ApiError::Provider("The Telegram bot could not send the message.".to_owned())
    })
}
