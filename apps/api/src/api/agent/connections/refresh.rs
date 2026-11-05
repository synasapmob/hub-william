//! Refreshing one connection's credential with its provider, and what a refusal
//! means for the account.

use std::{str::FromStr, sync::atomic::Ordering};

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::{
    ACCOUNT_VERIFICATION_REQUIRED_MESSAGE, AgentConnection, CLAUDE_CLIENT_ID, CLAUDE_SCOPES,
    CODEX_CLIENT_ID, ConnectionRow, CredentialRow, PROVIDER_CREDENTIAL_REFRESH_MINUTES,
    RECOVERABLE_REAUTHORIZATION_MESSAGES,
    authorize::{grok_oauth_request, parse_token_response, validate_static_key},
    database_error,
    manage::{connection_from_row, owned_connection_by_id},
    metadata::resolved_connection_metadata,
    sweeps::{InFlightRefresh, SWEEPS_STOPPING},
    token::{
        access_token_fingerprint, decrypt_json, encrypt_json, merge_token_response,
        provider_expiry_at,
    },
    upstream_network_error, upstream_status_error,
};
use crate::{
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

/// A scheduled refresh that fails because the network or the provider is
/// unavailable is tried again after this pause, inside the same refresh. Two
/// attempts in all; after the second failure the account waits for its next
/// regular refresh.
const PROVIDER_CREDENTIAL_REFRESH_ATTEMPTS: usize = 2;
const PROVIDER_CREDENTIAL_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(3);
/// A refresh token that the provider reports will expire is refreshed this long
/// before it does, and never sooner than the minimum below from now.
const PROVIDER_CREDENTIAL_EXPIRY_MARGIN_MINUTES: i64 = 5;
const PROVIDER_CREDENTIAL_MIN_RESCHEDULE_SECONDS: i64 = 60;
pub(super) const EXPIRED_PROVIDER_AUTHORIZATION_MESSAGE: &str =
    "Provider authorization expired. Refresh this pool to reconnect.";

pub(super) enum RefreshConnectionOutcome {
    Connected {
        connection: AgentConnection,
        refreshed: bool,
    },
    ReauthorizationRequired(ConnectionRow),
}

#[derive(Clone, Copy, Debug)]
pub(super) enum CredentialRefreshMode {
    Force,
    NearExpiry,
    /// Scheduled rotation once the credential reaches its `next_refresh_at`.
    Stale,
    Nightly(DateTime<Utc>),
    /// Scheduled retry of an account the gateway marked for reconnect. A
    /// successful refresh restores it; a rejected refresh token keeps it
    /// waiting for its owner.
    Recover,
    /// A provider rejected this access token (SHA-256 fingerprint). Refresh
    /// only when it is still the stored token; otherwise another request has
    /// already rotated it and the caller retries with the stored credential.
    Rejected([u8; 32]),
}

impl CredentialRefreshMode {
    pub(super) fn records_scheduled_attempt(self) -> bool {
        matches!(self, Self::Stale | Self::Nightly(_) | Self::Recover)
    }

    pub(super) fn restores_availability(self) -> bool {
        matches!(self, Self::Force | Self::Recover)
    }

    fn label(self) -> &'static str {
        match self {
            Self::Force => "manual refresh",
            Self::NearExpiry => "request refresh",
            Self::Stale => "scheduled refresh",
            Self::Nightly(_) => "nightly check",
            Self::Recover => "scheduled recovery",
            Self::Rejected(_) => "rejected-token refresh",
        }
    }
}

/// When a credential is next due after a refresh or a failed attempt: 30
/// minutes ahead, or sooner when the provider reports that its refresh token
/// expires before then, so a lifetime renewed by the provider is picked up
/// before the old one ends. An expiry already in the past is ignored; it cannot
/// be refreshed around.
pub(super) fn next_regular_refresh_at(
    now: DateTime<Utc>,
    refresh_token_expires_at: Option<DateTime<Utc>>,
) -> DateTime<Utc> {
    let regular = now + Duration::minutes(PROVIDER_CREDENTIAL_REFRESH_MINUTES);
    refresh_token_expires_at
        .filter(|expires_at| *expires_at > now)
        .map(|expires_at| expires_at - Duration::minutes(PROVIDER_CREDENTIAL_EXPIRY_MARGIN_MINUTES))
        .filter(|before_expiry| *before_expiry < regular)
        .map_or(regular, |before_expiry| {
            before_expiry.max(now + Duration::seconds(PROVIDER_CREDENTIAL_MIN_RESCHEDULE_SECONDS))
        })
}

/// A refresh answer that says nothing about the credential itself: the provider
/// is unavailable, throttling, or slow. Anything else, such as a rejected
/// client, is not retried before the next regular refresh.
pub(super) fn refresh_status_is_transient(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || matches!(
            status,
            reqwest::StatusCode::TOO_MANY_REQUESTS | reqwest::StatusCode::REQUEST_TIMEOUT
        )
}

pub(super) enum ProviderRefreshError {
    ReauthorizationRequired,
    /// The network or the provider was unavailable. The refresh token was not
    /// shown to be bad, so a scheduled refresh retries soon.
    Transient(ApiError),
    Api(ApiError),
}

async fn finish_refresh_reauthorization(
    mut transaction: Transaction<'_, Postgres>,
    row: ConnectionRow,
    mode: CredentialRefreshMode,
) -> Result<RefreshConnectionOutcome, ApiError> {
    // Keep the credential lock until the failure state is committed. A fresh
    // login that writes this credential must then finish after this update.
    // Do not delete a concurrent manual reauthorization prompt.
    let updated = sqlx::query_as::<_, ConnectionRow>(
        "UPDATE agent_connections
         SET availability_status = 'reauth_required',
             failure_message = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'connected'
           AND availability_status <> 'reauth_required'
         RETURNING id, provider, status, availability_status, account_label, plan, failure_message, validation_url, created_at, updated_at",
    )
    .bind(row.id)
    .bind(EXPIRED_PROVIDER_AUTHORIZATION_MESSAGE)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    let updated = match updated {
        Some(updated) => {
            eprintln!(
                "{} connection {} requires reauthorization during {}",
                row.provider,
                row.id,
                mode.label()
            );
            updated
        }
        None => {
            if matches!(mode, CredentialRefreshMode::Recover) {
                // The refresh credential itself is dead, so stop retrying this
                // account until its owner reconnects it.
                sqlx::query(
                    "UPDATE agent_connections SET failure_message = $2, updated_at = NOW()
                     WHERE id = $1 AND availability_status = 'reauth_required'
                       AND failure_message = ANY($3)",
                )
                .bind(row.id)
                .bind(EXPIRED_PROVIDER_AUTHORIZATION_MESSAGE)
                .bind(
                    RECOVERABLE_REAUTHORIZATION_MESSAGES
                        .iter()
                        .map(|message| (*message).to_owned())
                        .collect::<Vec<_>>(),
                )
                .execute(&mut *transaction)
                .await
                .map_err(database_error)?;
            }
            sqlx::query_as::<_, ConnectionRow>(
                "SELECT id, provider, status, availability_status, account_label, plan, failure_message, validation_url,
                        created_at, updated_at
                 FROM agent_connections WHERE id = $1",
            )
            .bind(row.id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(database_error)?
        }
    };
    transaction.commit().await.map_err(database_error)?;
    Ok(RefreshConnectionOutcome::ReauthorizationRequired(updated))
}

/// Ask the provider to refresh the credential. A scheduled refresh that fails
/// on the network or the provider's availability is tried once more after a
/// short pause, still under the caller's credential lock; any other outcome,
/// and any request-time refresh, is returned as it came.
async fn refresh_provider_token_with_retry(
    state: &AppState,
    row: &ConnectionRow,
    provider: AgentProvider,
    refresh_token: &str,
    stored_token: &Value,
    mode: CredentialRefreshMode,
) -> Result<Value, ProviderRefreshError> {
    let mut attempt = 1;
    loop {
        match refresh_provider_token(state, provider, refresh_token, stored_token).await {
            Err(ProviderRefreshError::Transient(_))
                if mode.records_scheduled_attempt()
                    && attempt < PROVIDER_CREDENTIAL_REFRESH_ATTEMPTS
                    && !SWEEPS_STOPPING.load(Ordering::SeqCst) =>
            {
                eprintln!(
                    "{} connection {} refresh attempt {attempt}/{PROVIDER_CREDENTIAL_REFRESH_ATTEMPTS} failed; retrying in {}s",
                    row.provider,
                    row.id,
                    PROVIDER_CREDENTIAL_RETRY_DELAY.as_secs()
                );
                tokio::time::sleep(PROVIDER_CREDENTIAL_RETRY_DELAY).await;
                attempt += 1;
            }
            result => return result,
        }
    }
}

/// After a scheduled refresh failed on every attempt, wait for the next regular
/// refresh, sooner when the refresh token is about to end. The token was not
/// shown to be bad, so the account is not marked for reconnect.
async fn schedule_regular_refresh_after_failure(
    transaction: &mut Transaction<'_, Postgres>,
    row: &ConnectionRow,
    refresh_token_expires_at: Option<DateTime<Utc>>,
) -> Result<(), ApiError> {
    let next_refresh_at = next_regular_refresh_at(Utc::now(), refresh_token_expires_at);
    sqlx::query(
        "UPDATE agent_connection_credentials SET next_refresh_at = $2 WHERE connection_id = $1",
    )
    .bind(row.id)
    .bind(next_refresh_at)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    eprintln!(
        "{} connection {} scheduled refresh failed on all {PROVIDER_CREDENTIAL_REFRESH_ATTEMPTS} attempts; next attempt at {next_refresh_at}",
        row.provider, row.id
    );
    Ok(())
}

/// A refresh that failed after the provider answered still holds a rotated
/// credential, so commit it: the provider has already invalidated the token it
/// was given, and rolling the rotation back would leave a credential that can
/// never be refreshed again.
async fn finish_refresh_error(
    transaction: Transaction<'_, Postgres>,
    error: ApiError,
) -> Result<RefreshConnectionOutcome, ApiError> {
    transaction.commit().await.map_err(database_error)?;
    Err(error)
}

pub(super) async fn refresh_connected_connection(
    state: &AppState,
    row: ConnectionRow,
    mode: CredentialRefreshMode,
) -> Result<RefreshConnectionOutcome, ApiError> {
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let credential = sqlx::query_as::<_, CredentialRow>(
        "SELECT credential_ciphertext, credential_nonce, access_token_expires_at,
         refresh_token_expires_at, refresh_attempted_at, next_refresh_at, updated_at
         FROM agent_connection_credentials
         WHERE connection_id = $1 FOR UPDATE",
    )
    .bind(row.id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    let Some(credential) = credential else {
        let current = sqlx::query_as::<_, ConnectionRow>(
            "SELECT id, provider, status, availability_status, account_label, plan, failure_message, validation_url,
                    created_at, updated_at
             FROM agent_connections WHERE id = $1 FOR UPDATE",
        )
        .bind(row.id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(database_error)?;
        let credential_now_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM agent_connection_credentials WHERE connection_id = $1)",
        )
        .bind(row.id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(database_error)?;
        if credential_now_exists {
            transaction.commit().await.map_err(database_error)?;
            return connection_from_row(current, None).map(|connection| {
                RefreshConnectionOutcome::Connected {
                    connection,
                    refreshed: false,
                }
            });
        }
        return finish_refresh_reauthorization(transaction, current, mode).await;
    };

    let last_refresh_activity_at = credential
        .refresh_attempted_at
        .map_or(credential.updated_at, |attempted_at| {
            attempted_at.max(credential.updated_at)
        });
    let should_refresh = if let CredentialRefreshMode::Rejected(observed) = mode {
        match decrypt_json::<Value>(
            &state.config.credential_encryption_key,
            &credential.credential_ciphertext,
            &credential.credential_nonce,
        ) {
            Ok(stored) => {
                stored
                    .get("access_token")
                    .and_then(Value::as_str)
                    .map(access_token_fingerprint)
                    == Some(observed)
            }
            Err(error) => return finish_refresh_error(transaction, error).await,
        }
    } else {
        should_refresh_credential(
            mode,
            credential.access_token_expires_at,
            credential.next_refresh_at,
            last_refresh_activity_at,
            Utc::now(),
        )
    };
    if !should_refresh {
        transaction.commit().await.map_err(database_error)?;
        return connection_from_row(row, None).map(|connection| {
            RefreshConnectionOutcome::Connected {
                connection,
                refreshed: false,
            }
        });
    }
    if mode.records_scheduled_attempt() {
        // Move the account a regular interval ahead before talking to the
        // provider. Every outcome that is not a success or a short retry then
        // leaves it waiting that long, and an aborted attempt cannot make the
        // next minute's sweep pick it up again.
        sqlx::query(
            "UPDATE agent_connection_credentials SET refresh_attempted_at = NOW(),
                 next_refresh_at = NOW() + make_interval(mins => $2)
             WHERE connection_id = $1",
        )
        .bind(row.id)
        .bind(PROVIDER_CREDENTIAL_REFRESH_MINUTES as i32)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }

    let stored_token: Value = match decrypt_json(
        &state.config.credential_encryption_key,
        &credential.credential_ciphertext,
        &credential.credential_nonce,
    ) {
        Ok(stored_token) => stored_token,
        Err(error) => {
            return finish_refresh_error(transaction, error).await;
        }
    };
    let provider = AgentProvider::from_str(&row.provider)?;
    if matches!(provider, AgentProvider::Deepseek | AgentProvider::Groq) {
        let Some(api_key) = stored_token.get("access_token").and_then(Value::as_str) else {
            return finish_refresh_reauthorization(transaction, row, mode).await;
        };
        match validate_static_key(state, provider, api_key).await {
            Ok(()) => {}
            Err(ApiError::Validation(_)) => {
                return finish_refresh_reauthorization(transaction, row, mode).await;
            }
            Err(error) => return finish_refresh_error(transaction, error).await,
        }
        if mode.restores_availability() {
            restore_refreshed_availability(&mut transaction, row.id, mode).await?;
        }
        transaction.commit().await.map_err(database_error)?;
        let updated = owned_connection_by_id(state, row.id).await?;
        return connection_from_row(updated, None).map(|connection| {
            RefreshConnectionOutcome::Connected {
                connection,
                refreshed: true,
            }
        });
    }
    let Some(refresh_token) = stored_token.get("refresh_token").and_then(Value::as_str) else {
        return finish_refresh_reauthorization(transaction, row, mode).await;
    };
    let refreshed = match refresh_provider_token_with_retry(
        state,
        &row,
        provider,
        refresh_token,
        &stored_token,
        mode,
    )
    .await
    {
        Ok(refreshed) => refreshed,
        Err(ProviderRefreshError::ReauthorizationRequired) => {
            return finish_refresh_reauthorization(transaction, row, mode).await;
        }
        Err(ProviderRefreshError::Transient(error)) => {
            if mode.records_scheduled_attempt() {
                schedule_regular_refresh_after_failure(
                    &mut transaction,
                    &row,
                    credential.refresh_token_expires_at,
                )
                .await?;
            }
            return finish_refresh_error(transaction, error).await;
        }
        Err(ProviderRefreshError::Api(error)) => {
            return finish_refresh_error(transaction, error).await;
        }
    };
    let access_token_expires_at = provider_expiry_at(&refreshed, "expires_in");
    let refresh_token_expires_at = provider_expiry_at(&refreshed, "refresh_token_expires_in")
        .or(credential.refresh_token_expires_at);
    let next_refresh_at = next_regular_refresh_at(Utc::now(), refresh_token_expires_at);
    let merged = merge_token_response(stored_token, refreshed);
    let (credential_ciphertext, credential_nonce) =
        match encrypt_json(&state.config.credential_encryption_key, &merged) {
            Ok(encrypted) => encrypted,
            Err(error) => return finish_refresh_error(transaction, error).await,
        };
    // The provider has already rotated the refresh token, so write it before
    // the metadata lookup and the verification probe below: a rotation that is
    // rolled back or lost to a kill can never be replayed at the provider, and
    // the account would need its owner to reconnect.
    sqlx::query(
        "UPDATE agent_connection_credentials SET credential_ciphertext = $2,
         credential_nonce = $3, access_token_expires_at = $4,
         refresh_token_expires_at = $5, refresh_attempted_at = NOW(),
         next_refresh_at = $6, updated_at = NOW()
         WHERE connection_id = $1",
    )
    .bind(row.id)
    .bind(credential_ciphertext)
    .bind(credential_nonce)
    .bind(access_token_expires_at)
    .bind(refresh_token_expires_at)
    .bind(next_refresh_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;

    let (account_label, plan) = resolved_connection_metadata(state, provider, &merged).await;
    let (verification_probe, validation_url) = if provider == AgentProvider::Gemini
        && mode.restores_availability()
    {
        match (
            merged.get("access_token").and_then(Value::as_str),
            merged
                .get("cloudaicompanion_project")
                .and_then(Value::as_str),
        ) {
            (Some(access_token), Some(project)) => {
                let probe = crate::api::gateway::probe_gemini_account_verification(
                    state,
                    access_token,
                    project,
                )
                .await;
                let validation_url = if probe
                    == crate::api::gateway::GeminiVerificationProbe::ReauthorizationRequired
                {
                    crate::api::gateway::gemini_account_validation_url(state, access_token, project)
                        .await
                } else {
                    None
                };
                (probe, validation_url)
            }
            _ => (
                crate::api::gateway::GeminiVerificationProbe::Inconclusive,
                None,
            ),
        }
    } else {
        (crate::api::gateway::GeminiVerificationProbe::Verified, None)
    };

    let verification_required =
        verification_probe == crate::api::gateway::GeminiVerificationProbe::ReauthorizationRequired;
    let restores_availability = mode.restores_availability()
        && verification_probe == crate::api::gateway::GeminiVerificationProbe::Verified;
    if mode.records_scheduled_attempt() {
        // The rotated credential is already written, so a failure from here on
        // may roll back the connection state alone.
        sqlx::query("SAVEPOINT scheduled_credential_persistence")
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
    }
    let persistence = async {
        sqlx::query(
            "UPDATE agent_connections SET
            account_label = COALESCE($2, account_label),
            plan = COALESCE($3, plan),
            availability_status = CASE WHEN $4 THEN 'reauth_required' ELSE availability_status END,
            failure_message = CASE WHEN $4 THEN $5 ELSE failure_message END,
            validation_url = CASE WHEN $4 THEN COALESCE($6, validation_url) ELSE NULL END,
            updated_at = NOW()
         WHERE id = $1",
        )
        .bind(row.id)
        .bind(account_label)
        .bind(plan)
        .bind(verification_required)
        .bind(ACCOUNT_VERIFICATION_REQUIRED_MESSAGE)
        .bind(validation_url)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        if restores_availability {
            restore_refreshed_availability(&mut transaction, row.id, mode).await?;
        }
        Ok::<(), ApiError>(())
    }
    .await;
    if let Err(error) = persistence {
        if mode.records_scheduled_attempt() {
            sqlx::query("ROLLBACK TO SAVEPOINT scheduled_credential_persistence")
                .execute(&mut *transaction)
                .await
                .map_err(database_error)?;
        }
        return finish_refresh_error(transaction, error).await;
    }
    transaction.commit().await.map_err(database_error)?;
    let updated = owned_connection_by_id(state, row.id).await?;
    let remains_reauthorization_required = provider == AgentProvider::Gemini
        && mode.restores_availability()
        && verification_probe == crate::api::gateway::GeminiVerificationProbe::Inconclusive
        && sqlx::query_scalar::<_, String>(
            "SELECT availability_status FROM agent_connections WHERE id = $1",
        )
        .bind(row.id)
        .fetch_one(&state.pool)
        .await
        .map_err(database_error)?
            == "reauth_required";
    if verification_required || remains_reauthorization_required {
        return Ok(RefreshConnectionOutcome::ReauthorizationRequired(updated));
    }
    connection_from_row(updated, None).map(|connection| RefreshConnectionOutcome::Connected {
        connection,
        refreshed: true,
    })
}

pub(super) fn should_refresh_credential(
    mode: CredentialRefreshMode,
    access_token_expires_at: Option<DateTime<Utc>>,
    next_refresh_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> bool {
    match mode {
        CredentialRefreshMode::Force | CredentialRefreshMode::Rejected(_) => true,
        CredentialRefreshMode::NearExpiry => access_token_expires_at
            .is_some_and(|expires_at| expires_at <= now + Duration::minutes(5)),
        CredentialRefreshMode::Stale | CredentialRefreshMode::Recover => next_refresh_at <= now,
        CredentialRefreshMode::Nightly(day_start_utc) => updated_at < day_start_utc,
    }
}

/// Restore an account after its provider accepted a refreshed credential.
/// Scheduled recovery only restores the reconnect states it may retry; a
/// verification challenge or an owner's pending reconnect is left alone.
async fn restore_refreshed_availability(
    transaction: &mut Transaction<'_, Postgres>,
    connection_id: Uuid,
    mode: CredentialRefreshMode,
) -> Result<(), ApiError> {
    let recover_only = matches!(mode, CredentialRefreshMode::Recover);
    let restored = sqlx::query(
        "UPDATE agent_connections SET availability_status = 'active',
             rate_limited_until = NULL, retry_claimed_at = NULL, failure_message = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND (NOT $2 OR (availability_status = 'reauth_required'
                           AND failure_message = ANY($3)))",
    )
    .bind(connection_id)
    .bind(recover_only)
    .bind(
        RECOVERABLE_REAUTHORIZATION_MESSAGES
            .iter()
            .map(|message| (*message).to_owned())
            .collect::<Vec<_>>(),
    )
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?
    .rows_affected();
    if restored > 0 {
        // A successful refresh makes any unfinished reconnect prompt obsolete.
        // Leaving it would later expire and wrongly mark the account again.
        sqlx::query("DELETE FROM agent_connection_authorizations WHERE connection_id = $1")
            .bind(connection_id)
            .execute(&mut **transaction)
            .await
            .map_err(database_error)?;
    }
    Ok(())
}

/// Run a credential refresh in its own task. The provider may rotate the
/// refresh token as soon as it answers; if a dropped request or timeout
/// cancelled the caller before commit, the new token would be rolled back and
/// the next refresh would be rejected as reused.
pub(super) async fn refresh_detached(
    state: &AppState,
    row: ConnectionRow,
    mode: CredentialRefreshMode,
) -> Result<RefreshConnectionOutcome, ApiError> {
    let state = state.clone();
    let in_flight = InFlightRefresh::start();
    tokio::spawn(async move {
        let _in_flight = in_flight;
        refresh_connected_connection(&state, row, mode).await
    })
    .await
    .map_err(|error| {
        eprintln!("credential refresh task failed: {error}");
        ApiError::Internal
    })?
}

pub(super) async fn refresh_provider_token(
    state: &AppState,
    provider: AgentProvider,
    refresh_token: &str,
    stored_token: &Value,
) -> Result<Value, ProviderRefreshError> {
    let response = match provider {
        AgentProvider::Chatgpt => {
            state
                .http
                .post(format!("{}/oauth/token", state.config.codex_issuer))
                .header(
                    "user-agent",
                    format!("codex_cli_rs/{}", state.config.codex_client_version),
                )
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", CODEX_CLIENT_ID),
                    ("refresh_token", refresh_token),
                ])
                .send()
                .await
        }
        AgentProvider::Claude => {
            let scope = stored_token
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or(CLAUDE_SCOPES);
            state
                .http
                .post(&state.config.claude_token_url)
                .json(&serde_json::json!({
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": CLAUDE_CLIENT_ID,
                    "scope": scope,
                }))
                .send()
                .await
        }
        AgentProvider::Gemini => {
            state
                .http
                .post(&state.config.gemini_token_url)
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh_token),
                    ("client_id", state.config.gemini_client_id.as_str()),
                    ("client_secret", state.config.gemini_client_secret.as_str()),
                ])
                .send()
                .await
        }
        AgentProvider::Deepseek | AgentProvider::Groq => {
            return Err(ProviderRefreshError::ReauthorizationRequired);
        }
        AgentProvider::Grok => {
            grok_oauth_request(state, "/oauth2/token")
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", state.config.grok_client_id.as_str()),
                    ("refresh_token", refresh_token),
                ])
                .send()
                .await
        }
    }
    .map_err(|error| ProviderRefreshError::Transient(upstream_network_error(provider, error)))?;

    if !response.status().is_success() {
        let status = response.status();
        let payload = response.json::<Value>().await.ok();
        if refresh_requires_reauthorization(provider, status, payload.as_ref()) {
            return Err(ProviderRefreshError::ReauthorizationRequired);
        }
        let error = upstream_status_error(provider, status);
        return Err(if refresh_status_is_transient(status) {
            ProviderRefreshError::Transient(error)
        } else {
            ProviderRefreshError::Api(error)
        });
    }

    parse_token_response(provider, response)
        .await
        .map_err(ProviderRefreshError::Transient)
}

pub(super) fn refresh_requires_reauthorization(
    provider: AgentProvider,
    status: reqwest::StatusCode,
    payload: Option<&Value>,
) -> bool {
    if !matches!(
        status,
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNAUTHORIZED
    ) {
        return false;
    }
    let error = payload
        .and_then(|payload| payload.get("error"))
        .and_then(|error| {
            error
                .as_str()
                .or_else(|| error.get("type").and_then(Value::as_str))
        });
    if error == Some("invalid_grant") {
        return true;
    }
    provider == AgentProvider::Chatgpt
        && payload
            .and_then(|payload| payload.pointer("/error/code"))
            .and_then(Value::as_str)
            == Some("refresh_token_invalidated")
}
