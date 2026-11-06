//! The SERVICE product: agents the platform owns, paid for as they are used. A
//! customer tops up a wallet, creates a key that bills the wallet, and each
//! request the key sends is charged at the price of the model it names. Prices
//! are per million tokens by kind of token, and are rows in `service_model_prices`
//! (the price list), which the dashboard keeps.

use axum::{
    Json,
    extract::{Query, State},
};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    api::{
        auth::authenticated_user_id,
        gateway::{GatewayUsage, UsageScope, usage_for_user},
    },
    core::{ApiError, AppState},
    utils::provider_catalogue::{AgentProvider, provider},
};
use money::{MICRO_PER_DOLLAR, Price};

mod billing;
mod keys;
mod listings;
mod money;
mod routes;
mod stripe;
mod wallet;
pub(crate) use billing::{ChargedRequest, MIN_BALANCE_MICRO, authorize_request, charge_request};
pub(crate) use listings::{QuotaMetric, quota_from_json};
pub(crate) use money::Tokens;
pub(crate) use routes::{ServiceApi, routes};

#[cfg(test)]
mod tests;

#[cfg(all(test, feature = "database-tests"))]
mod database_tests;

#[cfg(all(test, feature = "database-tests"))]
mod stripe_tests;

const MIN_TOP_UP_MICRO: i64 = MICRO_PER_DOLLAR;
const MAX_TOP_UP_MICRO: i64 = 1_000 * MICRO_PER_DOLLAR;
/// The agents the service lists, in the order the Pricing page shows them.
const SERVICE_PROVIDERS: [AgentProvider; 6] = [
    AgentProvider::Chatgpt,
    AgentProvider::Gemini,
    AgentProvider::Claude,
    AgentProvider::Deepseek,
    AgentProvider::Grok,
    AgentProvider::Groq,
];
/// A model offered at several reasoning efforts is listed once, without these suffixes.
const EFFORT_SUFFIXES: [&str; 3] = ["high", "medium", "low"];

#[derive(Debug, Serialize, ToSchema)]
pub struct ServicePrice {
    /// Micro-dollars (1 USD = 1,000,000) per one million tokens.
    pub input_micro_per_million: i64,
    pub cached_micro_per_million: i64,
    pub output_micro_per_million: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ServiceModel {
    pub id: String,
    pub name: String,
    pub price: ServicePrice,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ServiceProvider {
    pub provider: AgentProvider,
    pub label: String,
    /// Whether the platform's stock has an account that can serve this agent now.
    /// When it has none, a request for it answers 502.
    pub available: bool,
    pub models: Vec<ServiceModel>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ServicePricing {
    pub currency: &'static str,
    pub providers: Vec<ServiceProvider>,
    /// A request starts only when the wallet holds at least this much, since what
    /// it costs is known only when it ends. Micro-dollars.
    pub min_balance_micro: i64,
    /// Whether topping up works without a payment. True on staging only.
    pub test_top_up: bool,
    /// Whether a top-up is paid by card, through Stripe Checkout.
    pub card_top_up: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ServiceWallet {
    /// What the customer holds, in micro-dollars.
    pub wallet_micro: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ServiceTopUp {
    /// What the customer holds, in micro-dollars. A payment by card is not in it
    /// until Stripe reports it.
    pub wallet_micro: i64,
    /// Where to send the customer to pay by card. None when the wallet was
    /// credited at once, which only happens where test top-ups are on.
    pub checkout_url: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ServiceAmount {
    /// Micro-dollars.
    pub amount_micro: i64,
}

/// An id that ends in an effort, as the model it belongs to and that effort.
fn split_effort(id: &str) -> Option<(&str, &'static str)> {
    EFFORT_SUFFIXES.iter().find_map(|effort| {
        id.strip_suffix(&format!("-{effort}"))
            .map(|base| (base, *effort))
    })
}

/// The ids the price list may know a requested model by, best first: the id as
/// named (a Gemini route carries a `models/` prefix), and that id without its
/// reasoning effort, since the effort variants of a model are sold as the model.
fn model_ids(requested: &str) -> Vec<String> {
    let requested = requested.trim_start_matches("models/");
    let mut ids = vec![requested.to_owned()];
    if let Some((base, _)) = split_effort(requested) {
        ids.push(base.to_owned());
    }

    ids
}

impl From<Price> for ServicePrice {
    fn from(price: Price) -> Self {
        Self {
            input_micro_per_million: price.input,
            cached_micro_per_million: price.cached,
            output_micro_per_million: price.output,
        }
    }
}

fn amount_in_range(amount_micro: i64, minimum: i64, maximum: i64) -> Result<i64, ApiError> {
    if (minimum..=maximum).contains(&amount_micro) {
        Ok(amount_micro)
    } else {
        Err(ApiError::Validation("The amount is out of range."))
    }
}

#[utoipa::path(
    get,
    path = "/service/pricing",
    responses((status = 200, description = "The agents the service offers, their models and what a million tokens of each cost", body = ServicePricing)),
    tag = "service"
)]
pub async fn pricing(State(state): State<AppState>) -> Result<Json<ServicePricing>, ApiError> {
    let listed = wallet::listed_prices(&state.pool).await?;
    let stocked = wallet::stocked_providers(&state.pool).await?;
    let providers = SERVICE_PROVIDERS
        .into_iter()
        .map(|id| ServiceProvider {
            provider: id,
            label: provider(id).label.clone(),
            available: stocked.contains(&id.to_string()),
            models: listed
                .iter()
                .filter(|row| row.provider == id.to_string())
                .map(|row| ServiceModel {
                    id: row.model.clone(),
                    name: if row.name.is_empty() {
                        row.model.clone()
                    } else {
                        row.name.clone()
                    },
                    price: row.price.into(),
                })
                .collect(),
        })
        .collect();

    Ok(Json(ServicePricing {
        currency: "USD",
        providers,
        min_balance_micro: MIN_BALANCE_MICRO,
        test_top_up: state.config.service_test_top_up,
        card_top_up: state.config.stripe_secret_key.is_some(),
    }))
}

#[utoipa::path(
    get,
    path = "/service/wallet",
    responses(
        (status = 200, description = "The signed-in user's wallet", body = ServiceWallet),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse)
    ),
    tag = "service"
)]
pub async fn wallet(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<ServiceWallet>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;

    Ok(Json(ServiceWallet {
        wallet_micro: wallet::read(&state.pool, user_id).await?,
    }))
}

#[utoipa::path(
    post,
    path = "/service/top-up",
    request_body = ServiceAmount,
    responses(
        (status = 200, description = "Where to pay by card, or the wallet after a test top-up", body = ServiceTopUp),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 422, description = "The amount is out of range, or not whole cents", body = crate::core::ErrorResponse),
        (status = 501, description = "Topping up is not available", body = crate::core::ErrorResponse),
        (status = 502, description = "The payment service could not open a checkout", body = crate::core::ErrorResponse)
    ),
    tag = "service"
)]
pub async fn top_up(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<ServiceAmount>,
) -> Result<Json<ServiceTopUp>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;

    top_up_for_user(&state, user_id, request.amount_micro)
        .await
        .map(Json)
}

/// With Stripe set up a top-up is a payment by card: the customer is sent to
/// Checkout and the wallet is credited when Stripe says it was paid. Without it,
/// and only where test top-ups are on, the wallet is credited at once.
pub(super) async fn top_up_for_user(
    state: &AppState,
    user_id: Uuid,
    amount_micro: i64,
) -> Result<ServiceTopUp, ApiError> {
    if state.config.stripe_secret_key.is_none() && !state.config.service_test_top_up {
        return Err(ApiError::NotAvailable("Top up is not available yet."));
    }
    let amount_micro = amount_in_range(amount_micro, MIN_TOP_UP_MICRO, MAX_TOP_UP_MICRO)?;
    if state.config.stripe_secret_key.is_some() {
        let checkout_url = stripe::start_checkout(state, user_id, amount_micro).await?;

        return Ok(ServiceTopUp {
            wallet_micro: wallet::read(&state.pool, user_id).await?,
            checkout_url: Some(checkout_url),
        });
    }

    Ok(ServiceTopUp {
        wallet_micro: wallet::top_up(&state.pool, user_id, amount_micro).await?,
        checkout_url: None,
    })
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ServiceUsageQuery {
    /// UTC calendar days, 1 through 365; defaults to 30.
    days: Option<i64>,
}

#[utoipa::path(
    get,
    path = "/service/usage",
    operation_id = "service_usage",
    params(ServiceUsageQuery),
    responses(
        (status = 200, description = "Requests the signed-in user sent with service keys, and what they were charged", body = GatewayUsage),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 422, description = "days is out of range", body = crate::core::ErrorResponse)
    ),
    tag = "service"
)]
pub async fn service_usage(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<ServiceUsageQuery>,
) -> Result<Json<GatewayUsage>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;

    usage_for_user(&state, user_id, query.days, UsageScope::Service)
        .await
        .map(Json)
}
