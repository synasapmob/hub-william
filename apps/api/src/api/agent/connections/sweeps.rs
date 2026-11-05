//! The background schedule that refreshes every connected credential, and how it
//! stops on shutdown.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::Notify;
use uuid::Uuid;

use super::{
    ConnectionRow, EXPIRED_AUTHORIZATION_PROMPT_MESSAGE, PROVIDER_CREDENTIAL_REFRESH_MINUTES,
    RECOVERABLE_REAUTHORIZATION_MESSAGES,
    refresh::{CredentialRefreshMode, RefreshConnectionOutcome, refresh_detached},
};
use crate::core::AppState;

#[derive(Debug, Default)]
pub struct ProviderCredentialRefreshSummary {
    pub failed: u64,
    pub reauthorization_required: u64,
    pub recovered: u64,
    pub refreshed: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCredentialRefreshStatus {
    Refreshed,
    ReauthorizationRequired,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct ProviderCredentialRefreshResult {
    pub connection_id: Uuid,
    pub provider: String,
    pub status: ProviderCredentialRefreshStatus,
}

/// Drop authorization prompts no owner finished and settle their connections
/// the way the polling path would have. A prompt left behind keeps its
/// connection out of the recovery sweep, so an abandoned reconnect could
/// otherwise leave an account reconnect-required with no way back.
pub async fn expire_abandoned_authorizations(state: &AppState) -> Result<u64, sqlx::Error> {
    let mut transaction = state.pool.begin().await?;
    let expired = sqlx::query_scalar::<_, Uuid>(
        "DELETE FROM agent_connection_authorizations
         WHERE expires_at <= NOW()
         RETURNING connection_id",
    )
    .fetch_all(&mut *transaction)
    .await?;
    if !expired.is_empty() {
        sqlx::query(
            "UPDATE agent_connections
             SET status = CASE WHEN status = 'connected' THEN 'connected' ELSE 'failed' END,
                 failure_message = CASE
                     WHEN status <> 'connected' OR availability_status = 'reauth_required'
                     THEN $2
                     ELSE failure_message
                 END,
                 updated_at = NOW()
             WHERE id = ANY($1)",
        )
        .bind(&expired)
        .bind(EXPIRED_AUTHORIZATION_PROMPT_MESSAGE)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(expired.len() as u64)
}

/// Every minute: rotate OAuth credentials whose stored `next_refresh_at` has
/// passed (30 minutes after their previous refresh), whether or not anyone is
/// using them, and retry
/// accounts the gateway marked for reconnect so a recovered provider session
/// returns to service without its owner. Static API keys are validated by the
/// nightly check instead; they are only retried here after a gateway rejection.
pub async fn refresh_due_provider_credentials(
    state: &AppState,
) -> Result<ProviderCredentialRefreshSummary, sqlx::Error> {
    let recoverable_messages: Vec<String> = RECOVERABLE_REAUTHORIZATION_MESSAGES
        .iter()
        .map(|message| (*message).to_owned())
        .collect();
    let rows = sqlx::query_as::<_, ConnectionRow>(
        "SELECT connections.id, connections.provider, connections.status, connections.availability_status,
                connections.account_label, connections.plan, connections.failure_message,
                connections.validation_url, connections.created_at, connections.updated_at
         FROM agent_connections AS connections
         JOIN agent_connection_credentials AS credentials
           ON credentials.connection_id = connections.id
         WHERE connections.status = 'connected'
           AND (
                 (connections.provider NOT IN ('deepseek', 'groq')
                  AND connections.availability_status <> 'reauth_required')
                 OR (connections.availability_status = 'reauth_required'
                     AND connections.failure_message = ANY($1)
                     AND NOT EXISTS (
                           SELECT 1 FROM agent_connection_authorizations AS authorizations
                           WHERE authorizations.connection_id = connections.id
                         ))
               )
           AND credentials.next_refresh_at <= NOW()
         ORDER BY credentials.next_refresh_at ASC",
    )
    .bind(recoverable_messages)
    .fetch_all(&state.pool)
    .await?;

    let rows = rows
        .into_iter()
        .map(|row| {
            let mode = if row.availability_status == "reauth_required" {
                CredentialRefreshMode::Recover
            } else {
                CredentialRefreshMode::Stale
            };
            (row, mode)
        })
        .collect();
    refresh_scheduled_provider_credentials(state, rows).await
}

/// Once per Vietnam calendar day, rotate connected OAuth credentials that have
/// not already refreshed today and validate static DeepSeek keys. The row-lock
/// recheck keeps this idempotent across API replicas and restarts.
pub async fn refresh_nightly_provider_credentials(
    state: &AppState,
    day_start_utc: DateTime<Utc>,
) -> Result<ProviderCredentialRefreshSummary, sqlx::Error> {
    let rows = sqlx::query_as::<_, ConnectionRow>(
        "SELECT connections.id, connections.provider, connections.status, connections.availability_status,
                connections.account_label, connections.plan, connections.failure_message,
                connections.validation_url, connections.created_at, connections.updated_at
         FROM agent_connections AS connections
         JOIN agent_connection_credentials AS credentials
           ON credentials.connection_id = connections.id
         WHERE connections.status = 'connected'
           AND connections.availability_status <> 'reauth_required'
           AND GREATEST(
                 credentials.updated_at,
                 COALESCE(credentials.refresh_attempted_at, credentials.updated_at)
               ) < $1
         ORDER BY connections.provider, connections.created_at",
    )
    .bind(day_start_utc)
    .fetch_all(&state.pool)
    .await?;

    let rows = rows
        .into_iter()
        .map(|row| (row, CredentialRefreshMode::Nightly(day_start_utc)))
        .collect();
    refresh_scheduled_provider_credentials(state, rows).await
}

async fn refresh_scheduled_provider_credentials(
    state: &AppState,
    rows: Vec<(ConnectionRow, CredentialRefreshMode)>,
) -> Result<ProviderCredentialRefreshSummary, sqlx::Error> {
    let mut summary = ProviderCredentialRefreshSummary::default();
    for (row, mode) in rows {
        if SWEEPS_STOPPING.load(Ordering::SeqCst) {
            break;
        }
        let connection_id = row.id;
        let provider = row.provider.clone();
        match refresh_detached(state, row, mode).await {
            Ok(RefreshConnectionOutcome::Connected {
                refreshed: true,
                connection,
            }) => {
                summary.refreshed += 1;
                if matches!(mode, CredentialRefreshMode::Recover)
                    && connection.availability_status != "reauth_required"
                {
                    summary.recovered += 1;
                    println!(
                        "{provider} connection {connection_id} recovered after a reconnect-required mark"
                    );
                }
            }
            Ok(RefreshConnectionOutcome::Connected {
                refreshed: false, ..
            }) => {}
            Ok(RefreshConnectionOutcome::ReauthorizationRequired(_)) => {
                summary.reauthorization_required += 1;
            }
            Err(error) => {
                summary.failed += 1;
                record_scheduled_refresh_attempt(state, connection_id).await;
                eprintln!(
                    "scheduled {provider} credential refresh failed for {connection_id}: {error:?}"
                );
            }
        }
    }

    Ok(summary)
}

/// Explicit operator maintenance: refresh every connected pool using its stored
/// credentials, including validating static DeepSeek keys. Does not start an
/// interactive authorization flow or stop after one provider fails.
pub async fn refresh_all_provider_credentials(
    state: &AppState,
) -> Result<Vec<ProviderCredentialRefreshResult>, sqlx::Error> {
    let rows = sqlx::query_as::<_, ConnectionRow>(
        "SELECT id, provider, status, availability_status, account_label, plan, failure_message, validation_url, created_at, updated_at
         FROM agent_connections WHERE status = 'connected' ORDER BY provider, created_at",
    )
    .fetch_all(&state.pool)
    .await?;

    let mut results = Vec::with_capacity(rows.len());
    for row in rows {
        let connection_id = row.id;
        let provider = row.provider.clone();
        let status = match refresh_detached(state, row, CredentialRefreshMode::Force).await {
            Ok(RefreshConnectionOutcome::Connected { .. }) => {
                ProviderCredentialRefreshStatus::Refreshed
            }
            Ok(RefreshConnectionOutcome::ReauthorizationRequired(_)) => {
                ProviderCredentialRefreshStatus::ReauthorizationRequired
            }
            Err(_) => ProviderCredentialRefreshStatus::Failed,
        };
        record_scheduled_refresh_attempt(state, connection_id).await;
        results.push(ProviderCredentialRefreshResult {
            connection_id,
            provider,
            status,
        });
    }
    Ok(results)
}

/// Record an attempt that did not leave a schedule behind, such as one whose
/// transaction rolled back. An account still overdue waits a regular interval
/// instead of being picked up again by the next minute's sweep; a schedule the
/// attempt already set, like a short retry, is kept.
async fn record_scheduled_refresh_attempt(state: &AppState, connection_id: Uuid) {
    if let Err(error) = sqlx::query(
        "UPDATE agent_connection_credentials SET refresh_attempted_at = NOW(),
             next_refresh_at = CASE WHEN next_refresh_at <= NOW()
                                    THEN NOW() + make_interval(mins => $2)
                                    ELSE next_refresh_at END
         WHERE connection_id = $1",
    )
    .bind(connection_id)
    .bind(PROVIDER_CREDENTIAL_REFRESH_MINUTES as i32)
    .execute(&state.pool)
    .await
    {
        eprintln!(
            "scheduled credential refresh attempt could not be recorded for {connection_id}: {error}"
        );
    }
}

pub(super) static SWEEPS_STOPPING: AtomicBool = AtomicBool::new(false);
static IN_FLIGHT_REFRESHES: AtomicUsize = AtomicUsize::new(0);
static REFRESHES_SETTLED: Notify = Notify::const_new();

/// Counts a detached refresh until its task finishes, even if it panics.
pub(super) struct InFlightRefresh;

impl InFlightRefresh {
    pub(super) fn start() -> Self {
        IN_FLIGHT_REFRESHES.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for InFlightRefresh {
    fn drop(&mut self) {
        if IN_FLIGHT_REFRESHES.fetch_sub(1, Ordering::SeqCst) == 1 {
            REFRESHES_SETTLED.notify_waiters();
        }
    }
}

/// Stop scheduled sweeps from starting another account. Called as soon as the
/// process is asked to shut down; a refresh already talking to its provider
/// still finishes and commits.
pub fn stop_credential_sweeps() {
    SWEEPS_STOPPING.store(true, Ordering::SeqCst);
}

/// Wait until no detached credential refresh is running, or `limit` passes.
/// Returns whether every refresh settled. A provider may already have rotated
/// a refresh token, so shutdown waits for the commit instead of dropping it.
pub async fn wait_for_credential_refreshes(limit: std::time::Duration) -> bool {
    tokio::time::timeout(limit, async {
        loop {
            let settled = REFRESHES_SETTLED.notified();
            tokio::pin!(settled);
            settled.as_mut().enable();
            if IN_FLIGHT_REFRESHES.load(Ordering::SeqCst) == 0 {
                return;
            }
            settled.await;
        }
    })
    .await
    .is_ok()
}
