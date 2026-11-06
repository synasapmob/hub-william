//! What the signed-in user has used through the gateway, read back from
//! `gateway_usage_events`. The Workspace and the Service each read their own
//! requests: those of Hub keys and of the Playground, or those of service keys.

use std::collections::HashMap;

use axum::{
    Json,
    extract::{Query, State},
};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use super::database_error;
use crate::{
    api::auth::authenticated_user_id,
    core::{ApiError, AppState},
};

const DEFAULT_PERIOD_DAYS: i64 = 30;
const MAX_PERIOD_DAYS: i64 = 365;

#[derive(Debug, Deserialize, IntoParams)]
pub struct GatewayUsageQuery {
    /// UTC calendar days, 1 through 365; defaults to 30.
    days: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GatewayUsageDay {
    pub date: String,
    pub requests: i64,
    pub known_total_tokens: i64,
    pub token_known_requests: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GatewayUsageBreakdown {
    /// The Hub key that sent the requests; none for the Playground, or for a
    /// key that has since been deleted.
    pub gateway_key_id: Option<Uuid>,
    pub key_last_four: Option<String>,
    pub provider: String,
    pub model: Option<String>,
    pub requests: i64,
    pub completed_requests: i64,
    pub token_known_requests: i64,
    pub known_input_tokens: i64,
    pub known_output_tokens: i64,
    pub known_cached_tokens: i64,
    /// What these requests were charged to the service wallet, in micro-dollars;
    /// zero for the Workspace, whose requests are free.
    pub spent_micro: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GatewayUsage {
    pub period_days: i64,
    pub requests: i64,
    /// What the requests were charged to the service wallet, in micro-dollars;
    /// zero for the Workspace, whose requests are free.
    pub spent_micro: i64,
    /// Requests the provider finished; the rest were abandoned or failed.
    pub completed_requests: i64,
    pub token_known_requests: i64,
    pub known_input_tokens: i64,
    pub known_output_tokens: i64,
    pub known_cached_tokens: i64,
    pub daily_usage: Vec<GatewayUsageDay>,
    pub breakdown: Vec<GatewayUsageBreakdown>,
}

#[derive(FromRow)]
struct TotalsRow {
    requests: i64,
    completed_requests: i64,
    token_known_requests: i64,
    known_input_tokens: i64,
    known_output_tokens: i64,
    known_cached_tokens: i64,
}

#[derive(FromRow)]
struct DayRow {
    date: NaiveDate,
    requests: i64,
    known_total_tokens: i64,
    token_known_requests: i64,
}

#[derive(FromRow)]
struct BreakdownRow {
    gateway_key_id: Option<Uuid>,
    key_last_four: Option<String>,
    provider: String,
    model: Option<String>,
    requests: i64,
    completed_requests: i64,
    token_known_requests: i64,
    known_input_tokens: i64,
    known_output_tokens: i64,
    known_cached_tokens: i64,
    spent_micro: i64,
}

/// Whose requests a read-back counts.
#[derive(Clone, Copy)]
pub(crate) enum UsageScope {
    /// The Workspace's own requests, which are free: workspace keys and the
    /// Playground on the user's own accounts.
    Workspace,
    /// Service keys, which are charged.
    Service,
}

impl UsageScope {
    /// A condition on `gateway_usage_events` that keeps this scope's requests.
    fn filter(self) -> &'static str {
        match self {
            Self::Workspace => "AND scope = 'workspace'",
            Self::Service => "AND scope = 'service'",
        }
    }
}

struct Period {
    days: i64,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    first_day: NaiveDate,
}

fn period(days: Option<i64>) -> Result<Period, ApiError> {
    let days = days.unwrap_or(DEFAULT_PERIOD_DAYS);
    if !(1..=MAX_PERIOD_DAYS).contains(&days) {
        return Err(ApiError::Validation("days must be between 1 and 365."));
    }
    let today = Utc::now().date_naive();
    let first_day = today - Duration::days(days - 1);
    let start = first_day.and_hms_opt(0, 0, 0).ok_or(ApiError::Internal)?;
    let end = (today + Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .ok_or(ApiError::Internal)?;
    Ok(Period {
        days,
        start: DateTime::from_naive_utc_and_offset(start, Utc),
        end: DateTime::from_naive_utc_and_offset(end, Utc),
        first_day,
    })
}

#[utoipa::path(
    get,
    path = "/gateway-usage",
    params(GatewayUsageQuery),
    responses(
        (status = 200, description = "Requests the signed-in user sent through the gateway with Hub keys and in the Playground; service keys are not counted", body = GatewayUsage),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 422, description = "days is out of range", body = crate::core::ErrorResponse)
    ),
    tag = "gateway keys"
)]
pub async fn gateway_usage(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<GatewayUsageQuery>,
) -> Result<Json<GatewayUsage>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;

    usage_for_user(&state, user_id, query.days, UsageScope::Workspace)
        .await
        .map(Json)
}

pub(crate) async fn usage_for_user(
    state: &AppState,
    user_id: Uuid,
    days: Option<i64>,
    scope: UsageScope,
) -> Result<GatewayUsage, ApiError> {
    let period = period(days)?;
    let scope_filter = scope.filter();

    let totals_sql = format!(
        "SELECT COUNT(*) AS requests,
                COUNT(*) FILTER (WHERE outcome = 'completed') AS completed_requests,
                COUNT(*) FILTER (WHERE input_tokens IS NOT NULL
                                 AND output_tokens IS NOT NULL) AS token_known_requests,
                COALESCE(SUM(input_tokens), 0)::bigint AS known_input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS known_output_tokens,
                COALESCE(SUM(cached_tokens), 0)::bigint AS known_cached_tokens
         FROM gateway_usage_events
         WHERE user_id = $1 AND created_at >= $2 AND created_at < $3 {scope_filter}"
    );
    let totals = sqlx::query_as::<_, TotalsRow>(&totals_sql)
        .bind(user_id)
        .bind(period.start)
        .bind(period.end)
        .fetch_one(&state.pool)
        .await
        .map_err(database_error)?;

    let daily_sql = format!(
        "SELECT (created_at AT TIME ZONE 'UTC')::date AS date,
                COUNT(*) AS requests,
                COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))
                         FILTER (WHERE input_tokens IS NOT NULL
                                 AND output_tokens IS NOT NULL), 0)::bigint AS known_total_tokens,
                COUNT(*) FILTER (WHERE input_tokens IS NOT NULL
                                 AND output_tokens IS NOT NULL) AS token_known_requests
         FROM gateway_usage_events
         WHERE user_id = $1 AND created_at >= $2 AND created_at < $3 {scope_filter}
         GROUP BY 1"
    );
    let days_with_requests = sqlx::query_as::<_, DayRow>(&daily_sql)
        .bind(user_id)
        .bind(period.start)
        .bind(period.end)
        .fetch_all(&state.pool)
        .await
        .map_err(database_error)?;
    let mut by_date: HashMap<NaiveDate, DayRow> = days_with_requests
        .into_iter()
        .map(|row| (row.date, row))
        .collect();
    // Every day of the period is present, so the chart has no gaps.
    let daily_usage = (0..period.days)
        .map(|offset| {
            let date = period.first_day + Duration::days(offset);
            let row = by_date.remove(&date);

            GatewayUsageDay {
                date: date.to_string(),
                requests: row.as_ref().map_or(0, |row| row.requests),
                known_total_tokens: row.as_ref().map_or(0, |row| row.known_total_tokens),
                token_known_requests: row.as_ref().map_or(0, |row| row.token_known_requests),
            }
        })
        .collect();

    let breakdown_sql = format!(
        "SELECT events.gateway_key_id, keys.last_four AS key_last_four,
                events.provider, events.model,
                COUNT(*) AS requests,
                COUNT(*) FILTER (WHERE events.outcome = 'completed') AS completed_requests,
                COUNT(*) FILTER (WHERE events.input_tokens IS NOT NULL
                                 AND events.output_tokens IS NOT NULL) AS token_known_requests,
                COALESCE(SUM(events.input_tokens), 0)::bigint AS known_input_tokens,
                COALESCE(SUM(events.output_tokens), 0)::bigint AS known_output_tokens,
                COALESCE(SUM(events.cached_tokens), 0)::bigint AS known_cached_tokens,
                COALESCE(SUM(charges.amount_micro), 0)::bigint AS spent_micro
         FROM gateway_usage_events AS events
         LEFT JOIN gateway_keys AS keys ON keys.id = events.gateway_key_id
         LEFT JOIN service_ledger AS charges ON charges.usage_event_id = events.id
         WHERE events.user_id = $1 AND events.created_at >= $2 AND events.created_at < $3
               {scope_filter}
         GROUP BY events.gateway_key_id, keys.last_four, events.provider, events.model
         ORDER BY requests DESC, events.provider, events.model, keys.last_four"
    );
    let breakdown = sqlx::query_as::<_, BreakdownRow>(&breakdown_sql)
        .bind(user_id)
        .bind(period.start)
        .bind(period.end)
        .fetch_all(&state.pool)
        .await
        .map_err(database_error)?;

    Ok(GatewayUsage {
        period_days: period.days,
        spent_micro: breakdown.iter().map(|row| row.spent_micro).sum(),
        requests: totals.requests,
        completed_requests: totals.completed_requests,
        token_known_requests: totals.token_known_requests,
        known_input_tokens: totals.known_input_tokens,
        known_output_tokens: totals.known_output_tokens,
        known_cached_tokens: totals.known_cached_tokens,
        daily_usage,
        breakdown: breakdown
            .into_iter()
            .map(|row| GatewayUsageBreakdown {
                gateway_key_id: row.gateway_key_id,
                key_last_four: row.key_last_four,
                provider: row.provider,
                model: row.model,
                requests: row.requests,
                completed_requests: row.completed_requests,
                token_known_requests: row.token_known_requests,
                known_input_tokens: row.known_input_tokens,
                known_output_tokens: row.known_output_tokens,
                known_cached_tokens: row.known_cached_tokens,
                spent_micro: row.spent_micro,
            })
            .collect(),
    })
}
