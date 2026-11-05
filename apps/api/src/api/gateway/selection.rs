//! Which provider accounts a request may use, and how each one answered it
//! (rate limited, needs reauthorization, back to active).

use axum::{
    http::{HeaderName, HeaderValue},
    response::Response,
};
use chrono::{DateTime, Duration, Utc};
use sqlx::FromRow;
use uuid::Uuid;

use super::{database_error, keys::AuthorizedGatewayKey};
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
            connection_id: None,
            organization_id: None,
        }
    }
}

impl From<AuthorizedGatewayKey> for GatewaySelection {
    fn from(key: AuthorizedGatewayKey) -> Self {
        Self {
            user_id: key.user_id,
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

pub(super) async fn mark_rate_limited(
    state: &AppState,
    connection_id: Uuid,
) -> Result<(), ApiError> {
    let retry_at = Utc::now() + rate_limit_cooldown();
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

pub(super) fn rate_limit_cooldown() -> Duration {
    Duration::minutes(30)
}
