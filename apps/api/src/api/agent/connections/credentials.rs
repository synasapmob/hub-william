//! Handing a connection's stored credential to the gateway and Playground, and
//! marking an account when its provider rejects it.

use std::str::FromStr;

use chrono::Utc;
use serde_json::Value;
use uuid::Uuid;

use super::{
    ACCOUNT_VERIFICATION_REQUIRED_MESSAGE, AgentConnectionStatus, CredentialRow, database_error,
    manage::owned_connection_by_id,
    refresh::{
        CredentialRefreshMode, RefreshConnectionOutcome, refresh_detached,
        should_refresh_credential,
    },
    token::{access_token_fingerprint, decrypt_json},
};
use crate::{
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

/// A usable provider credential, or proof that its owner must reconnect it.
pub(crate) enum CredentialLookup {
    Ready(AgentProvider, Value),
    ReauthorizationRequired,
}

pub(crate) async fn provider_credential(
    state: &AppState,
    connection_id: Uuid,
) -> Result<(AgentProvider, Value), ApiError> {
    match gateway_credential(state, connection_id).await? {
        CredentialLookup::Ready(provider, token) => Ok((provider, token)),
        CredentialLookup::ReauthorizationRequired => Err(ApiError::Forbidden),
    }
}

/// The current credential for a request. Most requests read it without a row
/// lock, so many members sharing one account do not queue behind each other or
/// behind a background refresh; only a credential about to expire takes the
/// lock and refreshes.
pub(crate) async fn gateway_credential(
    state: &AppState,
    connection_id: Uuid,
) -> Result<CredentialLookup, ApiError> {
    let row = owned_connection_by_id(state, connection_id).await?;
    if AgentConnectionStatus::from_str(&row.status)? != AgentConnectionStatus::Connected {
        return Err(ApiError::Forbidden);
    }
    let provider = AgentProvider::from_str(&row.provider)?;
    if let Some(credential) = stored_credential_row(state, connection_id).await?
        && !should_refresh_credential(
            CredentialRefreshMode::NearExpiry,
            credential.access_token_expires_at,
            credential.next_refresh_at,
            credential.updated_at,
            Utc::now(),
        )
    {
        let token = decrypt_json(
            &state.config.credential_encryption_key,
            &credential.credential_ciphertext,
            &credential.credential_nonce,
        )?;
        return Ok(CredentialLookup::Ready(provider, token));
    }

    match refresh_detached(state, row, CredentialRefreshMode::NearExpiry).await? {
        RefreshConnectionOutcome::Connected { .. } => {}
        RefreshConnectionOutcome::ReauthorizationRequired(_) => {
            return Ok(CredentialLookup::ReauthorizationRequired);
        }
    }
    current_credential(state, connection_id).await
}

/// Recover from a provider rejecting `observed_access_token`. Under the
/// credential lock, rotate it once if it is still the stored token, or return
/// the token another request already rotated in. Only a rejected refresh
/// credential marks the account for reconnect here; a transient provider or
/// network failure is returned as an error and leaves the account unchanged.
pub(crate) async fn recover_rejected_credential(
    state: &AppState,
    connection_id: Uuid,
    observed_access_token: &str,
) -> Result<CredentialLookup, ApiError> {
    let row = owned_connection_by_id(state, connection_id).await?;
    if AgentConnectionStatus::from_str(&row.status)? != AgentConnectionStatus::Connected {
        return Err(ApiError::Forbidden);
    }
    let mode = CredentialRefreshMode::Rejected(access_token_fingerprint(observed_access_token));
    match refresh_detached(state, row, mode).await? {
        RefreshConnectionOutcome::Connected { .. } => {
            current_credential(state, connection_id).await
        }
        RefreshConnectionOutcome::ReauthorizationRequired(_) => {
            Ok(CredentialLookup::ReauthorizationRequired)
        }
    }
}

async fn stored_credential_row(
    state: &AppState,
    connection_id: Uuid,
) -> Result<Option<CredentialRow>, ApiError> {
    sqlx::query_as::<_, CredentialRow>(
        "SELECT credential_ciphertext, credential_nonce, access_token_expires_at,
         refresh_token_expires_at, refresh_attempted_at, next_refresh_at, updated_at
         FROM agent_connection_credentials
         WHERE connection_id = $1",
    )
    .bind(connection_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)
}

async fn current_credential(
    state: &AppState,
    connection_id: Uuid,
) -> Result<CredentialLookup, ApiError> {
    let row = owned_connection_by_id(state, connection_id).await?;
    if AgentConnectionStatus::from_str(&row.status)? != AgentConnectionStatus::Connected {
        return Err(ApiError::Forbidden);
    }
    let credential = stored_credential_row(state, connection_id)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let token = decrypt_json(
        &state.config.credential_encryption_key,
        &credential.credential_ciphertext,
        &credential.credential_nonce,
    )?;

    Ok(CredentialLookup::Ready(
        AgentProvider::from_str(&row.provider)?,
        token,
    ))
}

/// Apply an observed Code Assist verification challenge only while the same
/// access token is still stored. A completed reconnect changes the credential
/// under this row lock and must not be overwritten by an older response.
pub(crate) async fn mark_gemini_verification_required(
    state: &AppState,
    connection_id: Uuid,
    observed_access_token: &str,
    validation_url: Option<&str>,
) -> Result<bool, ApiError> {
    mark_reauthorization_required_if_current(
        state,
        connection_id,
        observed_access_token,
        ACCOUNT_VERIFICATION_REQUIRED_MESSAGE,
        validation_url,
    )
    .await
}

/// Mark an account for reconnect because the provider rejected
/// `observed_access_token`, but only while that token is still the stored one.
/// A refresh, reconnect or recovery that replaced it under the credential lock
/// wins over this older rejection.
pub(crate) async fn mark_reauthorization_required_if_current(
    state: &AppState,
    connection_id: Uuid,
    observed_access_token: &str,
    message: &'static str,
    validation_url: Option<&str>,
) -> Result<bool, ApiError> {
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let credential = sqlx::query_as::<_, CredentialRow>(
        "SELECT credential_ciphertext, credential_nonce, access_token_expires_at,
                refresh_token_expires_at, refresh_attempted_at, next_refresh_at, updated_at
         FROM agent_connection_credentials WHERE connection_id = $1 FOR UPDATE",
    )
    .bind(connection_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    let Some(credential) = credential else {
        transaction.commit().await.map_err(database_error)?;
        return Ok(false);
    };
    let current: Value = decrypt_json(
        &state.config.credential_encryption_key,
        &credential.credential_ciphertext,
        &credential.credential_nonce,
    )?;
    if current.get("access_token").and_then(Value::as_str) != Some(observed_access_token) {
        transaction.commit().await.map_err(database_error)?;
        return Ok(false);
    }
    let marked = sqlx::query_scalar::<_, String>(
        "UPDATE agent_connections
         SET availability_status = 'reauth_required', rate_limited_until = NULL,
             retry_claimed_at = NULL, failure_message = $2,
             validation_url = COALESCE($3, validation_url), updated_at = NOW()
         WHERE id = $1 AND status = 'connected'
         RETURNING provider",
    )
    .bind(connection_id)
    .bind(message)
    .bind(validation_url)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    if let Some(provider) = &marked {
        eprintln!("{provider} connection {connection_id} marked for reconnect: {message}");
    }
    Ok(marked.is_some())
}
