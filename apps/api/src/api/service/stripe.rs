//! Paying the wallet in by card with Stripe Checkout.
//!
//! The customer asks for an amount; the API opens a Checkout Session for it and
//! sends the customer to Stripe. Nothing is credited then. Stripe reports the
//! payment with a signed webhook, and that alone credits the wallet, once, for
//! the amount that was asked for.

use std::collections::HashMap;

use axum::{body::Bytes, extract::State, http::HeaderMap, http::StatusCode};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;
use uuid::Uuid;

use super::wallet::{self, TopUpOutcome};
use crate::core::{ApiError, AppState};

/// A webhook older than this, or this far in the future, is refused, so a
/// captured one cannot be replayed later.
const SIGNATURE_TOLERANCE_SECONDS: i64 = 300;
/// A cent is 10,000 micro-dollars.
const MICRO_PER_CENT: i64 = 10_000;

/// Whether `header` (the `Stripe-Signature` of a webhook) vouches for `body`. The
/// header is `t=<unix time>,v1=<hex signature>[,v1=...]`, and a signature is the
/// HMAC-SHA256 of `<t>.<body>` under the endpoint's signing secret. Any of the
/// `v1` signatures may match, which is how Stripe rolls a secret over.
pub(super) fn verify_signature(secret: &str, header: &str, body: &[u8], now: i64) -> bool {
    let mut timestamp = None;
    let mut signatures = Vec::new();
    for part in header.split(',') {
        match part.trim().split_once('=') {
            Some(("t", value)) => timestamp = value.parse::<i64>().ok(),
            Some(("v1", value)) => signatures.push(value),
            _ => {}
        }
    }
    let Some(timestamp) = timestamp else {
        return false;
    };
    if now.abs_diff(timestamp) > SIGNATURE_TOLERANCE_SECONDS.unsigned_abs() {
        return false;
    }

    signatures.into_iter().any(|signature| {
        let Some(expected) = decode_hex(signature) else {
            return false;
        };
        let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
            return false;
        };
        mac.update(timestamp.to_string().as_bytes());
        mac.update(b".");
        mac.update(body);

        // The comparison takes the same time wherever the two differ.
        mac.verify_slice(&expected).is_ok()
    })
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }

    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).ok())
        .collect()
}

/// What Stripe returns for a Checkout Session it opened.
#[derive(Deserialize)]
struct OpenedSession {
    id: String,
    url: Option<String>,
}

/// Opens a Checkout Session for a top-up and returns where to send the customer.
/// The top-up is recorded first, so that a payment can always be matched to it,
/// and is the id Stripe hands back in its webhook.
pub(super) async fn start_checkout(
    state: &AppState,
    user_id: Uuid,
    amount_micro: i64,
) -> Result<String, ApiError> {
    let Some(secret) = state.config.stripe_secret_key.as_deref() else {
        return Err(ApiError::NotAvailable("Card payments are not set up."));
    };
    if amount_micro % MICRO_PER_CENT != 0 {
        return Err(ApiError::Validation(
            "The amount must be a whole number of cents.",
        ));
    }
    let origin = state
        .config
        .frontend_origin
        .to_str()
        .map_err(|_| ApiError::Internal)?
        .trim_end_matches('/');
    let top_up_id = wallet::begin_top_up(&state.pool, user_id, amount_micro).await?;
    let top_up = top_up_id.to_string();
    let cents = (amount_micro / MICRO_PER_CENT).to_string();
    let form = [
        ("mode", "payment"),
        ("client_reference_id", &user_id.to_string()),
        ("metadata[top_up_id]", &top_up),
        ("line_items[0][quantity]", "1"),
        ("line_items[0][price_data][currency]", "usd"),
        ("line_items[0][price_data][unit_amount]", &cents),
        (
            "line_items[0][price_data][product_data][name]",
            "Hub William balance",
        ),
        (
            "success_url",
            &format!("{origin}/service/pricing?topup=success"),
        ),
        (
            "cancel_url",
            &format!("{origin}/service/pricing?topup=cancelled"),
        ),
    ];
    let opened = open_session(state, secret, &top_up, &form).await;
    let opened = match opened {
        Ok(opened) => opened,
        Err(error) => {
            wallet::expire_top_up(&state.pool, top_up_id).await?;

            return Err(error);
        }
    };
    let Some(url) = opened.url else {
        eprintln!("stripe opened session {} without a url", opened.id);
        wallet::expire_top_up(&state.pool, top_up_id).await?;

        return Err(unavailable());
    };
    // The webhook finds the top-up by its own id, so a failure here is only logged.
    if let Err(error) = wallet::attach_session(&state.pool, top_up_id, &opened.id).await {
        eprintln!("stripe session {} was not recorded: {error:?}", opened.id);
    }

    Ok(url)
}

fn unavailable() -> ApiError {
    ApiError::Provider("The payment service could not open a checkout. Try again.".to_owned())
}

async fn open_session(
    state: &AppState,
    secret: &str,
    idempotency_key: &str,
    form: &[(&str, &str)],
) -> Result<OpenedSession, ApiError> {
    let response = state
        .http
        .post(format!(
            "{}/v1/checkout/sessions",
            state.config.stripe_api_url.trim_end_matches('/')
        ))
        .basic_auth(secret, None::<&str>)
        .header(
            "Idempotency-Key",
            format!("service-top-up-{idempotency_key}"),
        )
        .form(form)
        .send()
        .await
        .map_err(|error| {
            eprintln!("stripe checkout request failed: {error}");
            unavailable()
        })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        eprintln!("stripe refused a checkout session: HTTP {status}: {body}");

        return Err(unavailable());
    }

    response.json().await.map_err(|error| {
        eprintln!("stripe checkout answer could not be read: {error}");
        unavailable()
    })
}

#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    data: EventData,
}

#[derive(Deserialize)]
struct EventData {
    object: Value,
}

/// The parts of a Checkout Session this API reads.
#[derive(Deserialize)]
struct Session {
    id: String,
    payment_status: Option<String>,
    /// What was paid, in the smallest unit of the currency (cents).
    amount_total: Option<i64>,
    currency: Option<String>,
    client_reference_id: Option<String>,
    metadata: Option<HashMap<String, String>>,
}

impl Session {
    /// The top-up this session was opened for, and the customer it was for.
    fn top_up(&self) -> Option<(Uuid, Option<Uuid>)> {
        let top_up_id = self.metadata.as_ref()?.get("top_up_id")?.parse().ok()?;
        let user_id = self
            .client_reference_id
            .as_deref()
            .and_then(|id| id.parse().ok());

        Some((top_up_id, user_id))
    }
}

/// Stripe's webhook. Every event that is signed is answered 200 once it has been
/// dealt with, including those that call for nothing; an answer that is not 200
/// makes Stripe send the event again, which is only wanted when the database
/// failed. A payment is credited for `checkout.session.completed` (and, for a
/// method that settles later, `checkout.session.async_payment_succeeded`) when
/// the session is paid; an `expired` session closes its top-up.
pub async fn stripe_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let Some(secret) = state.config.stripe_webhook_secret.as_deref() else {
        return Err(ApiError::NotAvailable("Card payments are not set up."));
    };
    let signature = headers
        .get("stripe-signature")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !verify_signature(secret, signature, &body, chrono::Utc::now().timestamp()) {
        return Err(ApiError::Forbidden);
    }
    let Ok(event) = serde_json::from_slice::<Event>(&body) else {
        // Signed, but not an event this API reads: nothing to do, nothing to repeat.
        return Ok(StatusCode::OK);
    };

    match event.kind.as_str() {
        "checkout.session.completed" | "checkout.session.async_payment_succeeded" => {
            if let Ok(session) = serde_json::from_value::<Session>(event.data.object) {
                credit(&state, &session).await?;
            }
        }
        "checkout.session.expired" => {
            if let Ok(session) = serde_json::from_value::<Session>(event.data.object)
                && let Some((top_up_id, _)) = session.top_up()
            {
                wallet::expire_top_up(&state.pool, top_up_id).await?;
            }
        }
        _ => {}
    }

    Ok(StatusCode::OK)
}

async fn credit(state: &AppState, session: &Session) -> Result<(), ApiError> {
    if session.payment_status.as_deref() != Some("paid") {
        return Ok(());
    }
    let Some((top_up_id, user_id)) = session.top_up() else {
        eprintln!("stripe session {} is paid but names no top-up", session.id);

        return Ok(());
    };
    let paid_micro = (session.currency.as_deref() == Some("usd"))
        .then_some(session.amount_total)
        .flatten()
        .and_then(|cents| cents.checked_mul(MICRO_PER_CENT));
    let Some(paid_micro) = paid_micro else {
        eprintln!(
            "stripe session {} was paid in a currency or amount this API does not take",
            session.id
        );

        return Ok(());
    };

    match wallet::complete_top_up(&state.pool, top_up_id, user_id, paid_micro).await? {
        TopUpOutcome::Credited | TopUpOutcome::AlreadyCredited => {}
        // Money was taken and nothing was credited, so a person has to look.
        TopUpOutcome::Unknown => eprintln!(
            "stripe session {} was paid for top-up {top_up_id}, which does not exist",
            session.id
        ),
        TopUpOutcome::Mismatch => eprintln!(
            "stripe session {} was paid {paid_micro} micro-dollars for top-up {top_up_id}, \
             which asked for something else; nothing was credited",
            session.id
        ),
    }

    Ok(())
}

/// The `Stripe-Signature` header Stripe would send for `body` at `timestamp`.
#[cfg(test)]
pub(super) fn signature_header(secret: &str, body: &str, timestamp: i64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(format!("{timestamp}.{body}").as_bytes());
    let signature: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    format!("t={timestamp},v1={signature}")
}
