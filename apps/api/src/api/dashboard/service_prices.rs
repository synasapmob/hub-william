//! What the Service charges: one row for each model, the price of a million
//! tokens by kind of token. The Pricing page, the check before a request and the
//! charge after it all read these rows, so a change here takes effect at once.
//! A row is never deleted: a request that is on its way is charged at its row
//! whether or not it is still for sale, so a model is taken off sale by unlisting
//! it.

use axum::{Json, extract::State};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::core::{ApiError, AppState};

use super::{
    access::{Permission, authorize},
    database_error,
};

/// The agents the Service sells, in the order its Pricing page shows them.
const PROVIDERS: [&str; 6] = ["chatgpt", "gemini", "claude", "deepseek", "grok", "groq"];

/// $1,000 a million tokens: far above any price, and far below overflow.
const MAXIMUM_MICRO_PER_MILLION: i64 = 1_000_000_000;
const MAXIMUM_MODEL_CHARACTERS: usize = 128;
const MAXIMUM_NAME_CHARACTERS: usize = 80;

#[derive(Debug, Serialize, ToSchema, sqlx::FromRow)]
pub struct DashboardServiceModel {
    /// Micro-dollars for a million cached input tokens.
    pub cached_micro_per_million: i64,
    /// Micro-dollars for a million new input tokens.
    pub input_micro_per_million: i64,
    /// Whether customers can use it; an unlisted model is refused.
    pub listed: bool,
    /// The id the agent's API uses.
    pub model: String,
    /// What the Pricing page calls it.
    pub name: String,
    /// Micro-dollars for a million output tokens.
    pub output_micro_per_million: i64,
    /// Among its agent's models, smallest first.
    pub position: i32,
    pub provider: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardServiceModels {
    pub models: Vec<DashboardServiceModel>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SaveServiceModel {
    pub cached_micro_per_million: i64,
    pub input_micro_per_million: i64,
    pub listed: bool,
    /// The id the agent's API uses. A model that has a row is changed, any other
    /// is added.
    pub model: String,
    pub name: String,
    pub output_micro_per_million: i64,
    /// `chatgpt`, `gemini`, `claude`, `deepseek`, `grok` or `groq`.
    pub provider: String,
}

#[utoipa::path(
    get,
    path = "/dashboard/service/models",
    responses(
        (status = 200, description = "Every model with a price, listed or not", body = DashboardServiceModels),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn list_service_models(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<DashboardServiceModels>, ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;

    sqlx::query_as::<_, DashboardServiceModel>(
        "SELECT cached_micro_per_million, input_micro_per_million, listed, model, name,
                output_micro_per_million, position, provider
         FROM service_model_prices
         ORDER BY array_position($1::text[], provider), position, model",
    )
    .bind(PROVIDERS.map(str::to_owned).to_vec())
    .fetch_all(&state.pool)
    .await
    .map(|models| Json(DashboardServiceModels { models }))
    .map_err(database_error)
}

fn priced(micro: i64) -> Result<i64, ApiError> {
    (0..=MAXIMUM_MICRO_PER_MILLION)
        .contains(&micro)
        .then_some(micro)
        .ok_or(ApiError::Validation(
            "A price is between $0 and $1,000 for a million tokens.",
        ))
}

#[utoipa::path(
    put,
    path = "/dashboard/service/models",
    request_body = SaveServiceModel,
    responses(
        (status = 200, description = "The model as it is now priced", body = DashboardServiceModel),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 422, description = "The agent, the id, the name or a price is not valid", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn save_service_model(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<SaveServiceModel>,
) -> Result<Json<DashboardServiceModel>, ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;

    if !PROVIDERS.contains(&body.provider.as_str()) {
        return Err(ApiError::Validation(
            "The agent must be chatgpt, gemini, claude, deepseek, grok or groq.",
        ));
    }

    let model = body.model.trim();
    if model.is_empty()
        || model.chars().count() > MAXIMUM_MODEL_CHARACTERS
        || model.chars().any(char::is_whitespace)
    {
        return Err(ApiError::Validation(
            "A model id is 1 to 128 characters, without spaces.",
        ));
    }

    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > MAXIMUM_NAME_CHARACTERS {
        return Err(ApiError::Validation("A name is 1 to 80 characters."));
    }

    let input = priced(body.input_micro_per_million)?;
    let cached = priced(body.cached_micro_per_million)?;
    let output = priced(body.output_micro_per_million)?;

    // A new model goes last among its agent's; one that has a row keeps its place.
    sqlx::query_as::<_, DashboardServiceModel>(
        "INSERT INTO service_model_prices
            (provider, model, name, input_micro_per_million, cached_micro_per_million,
             output_micro_per_million, listed, position, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 (SELECT COALESCE(MAX(position), 0) + 1
                  FROM service_model_prices WHERE provider = $1),
                 NOW())
         ON CONFLICT (provider, model) DO UPDATE
         SET name = EXCLUDED.name,
             input_micro_per_million = EXCLUDED.input_micro_per_million,
             cached_micro_per_million = EXCLUDED.cached_micro_per_million,
             output_micro_per_million = EXCLUDED.output_micro_per_million,
             listed = EXCLUDED.listed,
             updated_at = NOW()
         RETURNING cached_micro_per_million, input_micro_per_million, listed, model, name,
                   output_micro_per_million, position, provider",
    )
    .bind(&body.provider)
    .bind(model)
    .bind(name)
    .bind(input)
    .bind(cached)
    .bind(output)
    .bind(body.listed)
    .fetch_one(&state.pool)
    .await
    .map(Json)
    .map_err(database_error)
}
