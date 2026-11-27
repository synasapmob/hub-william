//! Which provider accounts a request may use, and how each one answered it
//! (rate limited, needs reauthorization, back to active).

use axum::{
    http::{HeaderName, HeaderValue, StatusCode, header::RETRY_AFTER},
    response::Response,
};
use chrono::{DateTime, Duration, Utc};
use sqlx::FromRow;
use uuid::Uuid;

use super::{database_error, keys::AuthorizedGatewayKey, rate_limit::cooldown_for};
use crate::{
    api::agent::{PROVIDER_LOGIN_REQUIRED_MESSAGE, mark_reauthorization_required_if_current},
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

/// A browser request names the account to try first; key clients do not. Both
/// fail over across the same provider's accounts in their scope (personal
/// accounts and joined pools, or one organization's shared agents) and only
/// fail once every account there is unavailable.
#[derive(Clone, Copy)]
pub(super) struct GatewaySelection {
    pub(super) user_id: Uuid,
    /// The Hub key that sent the request; none for a browser session.
    pub(super) key_id: Option<Uuid>,
    pub(super) connection_id: Option<Uuid>,
    pub(super) organization_id: Option<Uuid>,
}

/// Names the account that served a browser request after automatic failover.
pub(crate) const SERVED_CONNECTION_HEADER: &str = "x-hub-connection-id";

pub(super) fn reauthorization_error(selection: GatewaySelection) -> ApiError {
    ApiError::Provider(
        match (selection.connection_id, selection.organization_id) {
            (Some(_), Some(_)) => {
                "Every account for this provider in this organization needs to reconnect. Their owners must complete provider reauthorization or account verification in Agents."
            }
            (Some(_), None) => {
                "Every account for this provider available to you needs to reconnect. Their owners must complete provider reauthorization or account verification in Agents."
            }
            (None, _) => "Every accessible pool for this provider needs to reconnect.",
        }
        .to_owned(),
    )
}

pub(super) fn served_by(
    mut response: Response,
    selection: GatewaySelection,
    connection_id: Uuid,
) -> Response {
    if selection.connection_id.is_some()
        && let Ok(value) = HeaderValue::from_str(&connection_id.to_string())
    {
        response
            .headers_mut()
            .insert(HeaderName::from_static(SERVED_CONNECTION_HEADER), value);
    }
    response
}

impl From<Uuid> for GatewaySelection {
    fn from(user_id: Uuid) -> Self {
        Self {
            user_id,
            key_id: None,
            connection_id: None,
            organization_id: None,
        }
    }
}

impl From<AuthorizedGatewayKey> for GatewaySelection {
    fn from(key: AuthorizedGatewayKey) -> Self {
        Self {
            user_id: key.user_id,
            key_id: Some(key.id),
            connection_id: None,
            organization_id: key.organization_id,
        }
    }
}

pub(super) async fn selected_provider_candidates(
    state: &AppState,
    selection: GatewaySelection,
    provider: AgentProvider,
) -> Result<Vec<ProviderCandidate>, ApiError> {
    let mut candidates = connected_provider_candidates(state, selection, provider).await?;
    if let Some(connection_id) = selection.connection_id {
        // The chosen account must be reachable in this scope. It is tried
        // first; the rest of the scope remains available for failover.
        let preferred = candidates
            .iter()
            .position(|candidate| candidate.id == connection_id)
            .ok_or(ApiError::Forbidden)?;
        let preferred = candidates.remove(preferred);
        candidates.insert(0, preferred);
    }
    if candidates.is_empty() {
        return Err(ApiError::Forbidden);
    }
    Ok(candidates)
}

#[derive(Debug, FromRow)]
pub(super) struct ProviderCandidate {
    pub(super) availability_status: String,
    pub(super) id: Uuid,
    rate_limited_until: Option<DateTime<Utc>>,
}

pub(super) async fn connected_provider_candidates(
    state: &AppState,
    selection: GatewaySelection,
    provider: AgentProvider,
) -> Result<Vec<ProviderCandidate>, ApiError> {
    if let Some(organization_id) = selection.organization_id {
        let candidates = sqlx::query_as::<_, ProviderCandidate>(
            "SELECT connections.id, connections.availability_status,
                    connections.rate_limited_until
             FROM organization_agents AS shares
             JOIN agent_connections AS connections
               ON connections.id = shares.connection_id
              AND connections.user_id = shares.owner_user_id
             JOIN organization_memberships AS members
               ON members.org_id = shares.org_id
              AND members.user_id = $2
              AND members.status = 'accepted'
             JOIN organization_memberships AS owners
               ON owners.org_id = shares.org_id
              AND owners.user_id = shares.owner_user_id
              AND owners.status = 'accepted'
             WHERE shares.org_id = $1
               AND connections.provider = $3
               AND connections.status = 'connected'
             ORDER BY CASE
                        WHEN connections.availability_status = 'half_open'
                             AND connections.retry_claimed_at IS NULL THEN 0
                        WHEN connections.availability_status = 'rate_limited'
                             AND connections.rate_limited_until <= NOW() THEN 1
                        WHEN connections.availability_status = 'active' THEN 2
                        ELSE 3
                      END,
                      shares.created_at DESC,
                      connections.id",
        )
        .bind(organization_id)
        .bind(selection.user_id)
        .bind(provider.to_string())
        .fetch_all(&state.pool)
        .await
        .map_err(database_error)?;
        if candidates.is_empty() {
            return Err(ApiError::Forbidden);
        }
        return Ok(candidates);
    }

    let candidates = sqlx::query_as::<_, ProviderCandidate>(
        "SELECT connections.id, connections.availability_status,
                connections.rate_limited_until
         FROM agent_connections AS connections
         LEFT JOIN agent_pool_join_requests AS requests
           ON requests.connection_id = connections.id
          AND requests.requester_user_id = $1
          AND requests.status = 'accepted'
         WHERE connections.provider = $2
           AND connections.status = 'connected'
           AND (connections.user_id = $1 OR requests.id IS NOT NULL)
         ORDER BY CASE
                    WHEN connections.availability_status = 'half_open'
                         AND connections.retry_claimed_at IS NULL THEN 0
                    WHEN connections.availability_status = 'rate_limited'
                         AND connections.rate_limited_until <= NOW() THEN 1
                    WHEN connections.availability_status = 'active' THEN 2
                    ELSE 3
                  END,
                  (connections.user_id = $1) DESC,
                  COALESCE(requests.updated_at, connections.updated_at) DESC
        ",
    )
    .bind(selection.user_id)
    .bind(provider.to_string())
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;
    if candidates.is_empty() {
        return Err(ApiError::Forbidden);
    }

    Ok(candidates)
}

pub(super) async fn claim_candidate(
    state: &AppState,
    candidate: &ProviderCandidate,
) -> Result<Option<bool>, ApiError> {
    match candidate.availability_status.as_str() {
        "active" => Ok(Some(false)),
        "rate_limited"
            if candidate
                .rate_limited_until
                .is_some_and(|until| until <= Utc::now()) =>
        {
            let result = sqlx::query(
                "UPDATE agent_connections
                 SET availability_status = 'half_open', retry_claimed_at = NOW(), updated_at = NOW()
                 WHERE id = $1 AND availability_status = 'rate_limited'
                   AND rate_limited_until <= NOW()",
            )
            .bind(candidate.id)
            .execute(&state.pool)
            .await
            .map_err(database_error)?;
            Ok((result.rows_affected() == 1).then_some(true))
        }
        "half_open" => {
            let stale_before = Utc::now() - Duration::minutes(5);
            let result = sqlx::query(
                "UPDATE agent_connections
                 SET retry_claimed_at = NOW(), updated_at = NOW()
                 WHERE id = $1 AND availability_status = 'half_open'
                   AND (retry_claimed_at IS NULL OR retry_claimed_at <= $2)",
            )
            .bind(candidate.id)
            .bind(stale_before)
            .execute(&state.pool)
            .await
            .map_err(database_error)?;
            Ok((result.rows_affected() == 1).then_some(true))
        }
        "rate_limited" => Ok(None),
        "reauth_required" => Ok(None),
        _ => Err(ApiError::Internal),
    }
}

/// Rest an account for the default time after a rate limit that named no delay.
pub(super) async fn mark_rate_limited(
    state: &AppState,
    connection_id: Uuid,
) -> Result<(), ApiError> {
    mark_rate_limited_for(state, connection_id, cooldown_for(None)).await
}

pub(super) async fn mark_rate_limited_for(
    state: &AppState,
    connection_id: Uuid,
    cooldown: Duration,
) -> Result<(), ApiError> {
    let retry_at = Utc::now() + cooldown;
    sqlx::query(
        "UPDATE agent_connections
         SET availability_status = 'rate_limited', rate_limited_until = $2,
             retry_claimed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND availability_status <> 'reauth_required'",
    )
    .bind(connection_id)
    .bind(retry_at)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(())
}

/// Mark an account for reconnect after the provider rejected
/// `observed_access_token`, unless a newer credential has replaced it.
pub(super) async fn mark_reauth_required(
    state: &AppState,
    connection_id: Uuid,
    observed_access_token: &str,
) -> Result<bool, ApiError> {
    mark_reauthorization_required_if_current(
        state,
        connection_id,
        observed_access_token,
        PROVIDER_LOGIN_REQUIRED_MESSAGE,
        None,
    )
    .await
}

pub(super) async fn mark_active(state: &AppState, connection_id: Uuid) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE agent_connections
         SET availability_status = 'active', rate_limited_until = NULL,
             retry_claimed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND availability_status NOT IN ('active', 'reauth_required')",
    )
    .bind(connection_id)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(())
}

pub(super) async fn release_probe(state: &AppState, connection_id: Uuid) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE agent_connections SET retry_claimed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND availability_status = 'half_open'",
    )
    .bind(connection_id)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(())
}

/// How a request fared across the provider's accounts, and what to answer when
/// none served it. What the provider said during this request outranks what the
/// gateway remembers about accounts it did not call, so an old cooldown on one
/// account never hides a fresh 401 or 403 from another. Each state has its own
/// status: only a provider's 429, or accounts all still resting after one, is a 429.
#[derive(Default)]
pub(super) struct Failover {
    /// The provider rejected a login, or asked for verification, in this request.
    login_rejected: bool,
    /// A reply of the provider's own, relayed as it came; the last one wins.
    answer: Option<Response>,
    /// The request's own failure: the provider never answered, or the stored
    /// credential was unusable.
    error: Option<ApiError>,
    /// An account was not called because another request is probing it.
    probing: bool,
    /// The first moment an account that is resting after a rate limit is due.
    cooling_until: Option<DateTime<Utc>>,
    /// An account was not called because its owner has to reconnect it.
    needs_reconnect: bool,
}

impl Failover {
    /// An account this request could not claim, so did not call.
    pub(super) fn skipped(&mut self, candidate: &ProviderCandidate) {
        match candidate.availability_status.as_str() {
            "reauth_required" => self.needs_reconnect = true,
            "rate_limited" => match candidate.rate_limited_until {
                Some(until) if until > Utc::now() => {
                    self.cooling_until =
                        Some(self.cooling_until.map_or(until, |due| due.min(until)));
                }
                // Its rest is over and another request won the probe.
                _ => self.probing = true,
            },
            _ => self.probing = true,
        }
    }

    /// An account whose stored login is already known to need its owner.
    pub(super) fn needs_reconnect(&mut self) {
        self.needs_reconnect = true;
    }

    pub(super) fn login_rejected(&mut self) {
        self.login_rejected = true;
    }

    pub(super) fn answered(&mut self, response: Response) {
        self.answer = Some(response);
    }

    /// An account this request just put to rest after the provider's 429.
    pub(super) fn rested(&mut self, cooldown: Duration) {
        let due = Utc::now() + cooldown;
        self.cooling_until = Some(self.cooling_until.map_or(due, |first| first.min(due)));
    }

    pub(super) fn failed(&mut self, error: ApiError) {
        self.error = Some(error);
    }

    pub(super) fn into_response(self, selection: GatewaySelection) -> Result<Response, ApiError> {
        if !self.login_rejected
            && let Some(mut answer) = self.answer
        {
            // A provider's 429 that named no wait still tells the client when the
            // first account can be tried again.
            if answer.status() == StatusCode::TOO_MANY_REQUESTS
                && !answer.headers().contains_key(RETRY_AFTER)
                && let Some(due) = self.cooling_until
            {
                answer
                    .headers_mut()
                    .insert(RETRY_AFTER, HeaderValue::from(seconds_until(due)));
            }
            return Ok(answer);
        }
        Err(Failover {
            answer: None,
            ..self
        }
        .into_error(selection))
    }

    /// For a request that has nothing of the provider's to relay.
    pub(super) fn into_error(self, selection: GatewaySelection) -> ApiError {
        if self.login_rejected {
            reauthorization_error(selection)
        } else if let Some(error) = self.error {
            error
        } else if self.probing {
            ApiError::Recovering
        } else if let Some(due) = self.cooling_until {
            ApiError::RateLimited(Some(seconds_until(due)))
        } else if self.needs_reconnect {
            reauthorization_error(selection)
        } else {
            ApiError::Forbidden
        }
    }
}

/// Whole seconds until `due`, rounded up so a client that waits them is served.
fn seconds_until(due: DateTime<Utc>) -> u64 {
    (due - Utc::now())
        .num_milliseconds()
        .max(0)
        .cast_unsigned()
        .div_ceil(1000)
        .max(1)
}
