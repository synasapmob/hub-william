use std::{fmt, str::FromStr};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::core::ApiError;

pub(super) mod authorize;
mod credentials;
pub(super) mod manage;
mod metadata;
mod refresh;
mod sweeps;
mod token;

pub(crate) use authorize::load_gemini_code_assist;
pub(crate) use credentials::{
    CredentialLookup, gateway_credential, mark_gemini_verification_required,
    mark_reauthorization_required_if_current, provider_credential, recover_rejected_credential,
};
pub use metadata::refresh_stored_connection_metadata;
pub use sweeps::{
    ProviderCredentialRefreshResult, ProviderCredentialRefreshStatus,
    ProviderCredentialRefreshSummary, expire_abandoned_authorizations,
    refresh_all_provider_credentials, refresh_due_provider_credentials,
    refresh_nightly_provider_credentials, stop_credential_sweeps, wait_for_credential_refreshes,
};

const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
pub(crate) const ANTIGRAVITY_CLIENT_VERSION: &str = "antigravity/cli/1.3.5 (aidev_client; os_type=linux; arch=amd64; cl=998863838; auth_method=consumer)";

/// Background refresh cadence: every connected credential rotates 30 minutes
/// after its previous refresh. Each account's `next_refresh_at` is stored, so
/// accounts keep the spread of the times they were first connected.
const PROVIDER_CREDENTIAL_REFRESH_MINUTES: i64 = 30;

const ACCOUNT_VERIFICATION_REQUIRED_MESSAGE: &str =
    "Provider account verification is required. Reconnect this pool.";
pub(crate) const PROVIDER_LOGIN_REQUIRED_MESSAGE: &str =
    "Provider login is required. Reconnect this pool.";
const EXPIRED_AUTHORIZATION_PROMPT_MESSAGE: &str = "Authorization expired. Start again.";
/// Reconnect states that do not prove the stored refresh credential is dead.
/// The background sweep retries them and restores the account when the
/// provider accepts a refreshed credential. A Google account-verification
/// challenge belongs here: Google reports it for accounts that still serve
/// generations, so only a repeated rejected probe may keep the account marked.
const RECOVERABLE_REAUTHORIZATION_MESSAGES: [&str; 3] = [
    PROVIDER_LOGIN_REQUIRED_MESSAGE,
    EXPIRED_AUTHORIZATION_PROMPT_MESSAGE,
    ACCOUNT_VERIFICATION_REQUIRED_MESSAGE,
];

#[cfg(all(test, feature = "database-tests"))]
mod database_tests;

pub use crate::utils::provider_catalogue::AgentProvider;

impl AgentProvider {
    pub(crate) fn label(self) -> &'static str {
        &crate::utils::provider_catalogue::provider(self).label
    }
}

impl FromStr for AgentProvider {
    type Err = ApiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|id| id.as_str() == value)
            .ok_or(ApiError::Internal)
    }
}

impl fmt::Display for AgentProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentConnectionStatus {
    Pending,
    Connected,
    Failed,
    Disconnected,
}

impl FromStr for AgentConnectionStatus {
    type Err = ApiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pending" => Ok(Self::Pending),
            "connected" => Ok(Self::Connected),
            "failed" => Ok(Self::Failed),
            "disconnected" => Ok(Self::Disconnected),
            _ => Err(ApiError::Internal),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct StartAgentConnectionRequest {
    pub provider: AgentProvider,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CompleteAuthorizationRequest {
    pub callback_url: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ConnectDeepseekRequest {
    pub api_key: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ConnectGroqRequest {
    pub api_key: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentAuthorizationPrompt {
    pub authorization_url: String,
    pub expires_at: DateTime<Utc>,
    pub poll_after_seconds: u64,
    pub requires_callback_url: bool,
    pub user_code: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentConnection {
    pub account_label: Option<String>,
    pub authorization: Option<AgentAuthorizationPrompt>,
    pub availability_status: String,
    pub created_at: DateTime<Utc>,
    pub failure_message: Option<String>,
    pub id: Uuid,
    pub plan: Option<String>,
    pub provider: AgentProvider,
    pub status: AgentConnectionStatus,
    pub updated_at: DateTime<Utc>,
    /// The provider's own account-verification link while this account needs
    /// its owner to verify it, such as a Google Code Assist challenge.
    pub validation_url: Option<String>,
}

#[derive(Debug, FromRow)]
struct ConnectionRow {
    availability_status: String,
    account_label: Option<String>,
    created_at: DateTime<Utc>,
    failure_message: Option<String>,
    id: Uuid,
    plan: Option<String>,
    provider: String,
    status: String,
    updated_at: DateTime<Utc>,
    validation_url: Option<String>,
}

#[derive(Debug, FromRow)]
struct CredentialRow {
    access_token_expires_at: Option<DateTime<Utc>>,
    credential_ciphertext: Vec<u8>,
    credential_nonce: Vec<u8>,
    next_refresh_at: DateTime<Utc>,
    refresh_attempted_at: Option<DateTime<Utc>>,
    refresh_token_expires_at: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
}

fn upstream_network_error(provider: AgentProvider, error: reqwest::Error) -> ApiError {
    eprintln!("{} authorization request failed: {error}", provider.label());
    ApiError::Provider(format!(
        "{} authorization is temporarily unavailable. Try again.",
        provider.label()
    ))
}

fn upstream_status_error(provider: AgentProvider, status: reqwest::StatusCode) -> ApiError {
    eprintln!("{} authorization returned HTTP {status}", provider.label());
    ApiError::Provider(format!(
        "{} rejected the authorization request. Try again later.",
        provider.label()
    ))
}

fn upstream_payload_error(provider: AgentProvider) -> ApiError {
    eprintln!(
        "{} authorization returned an unexpected response",
        provider.label()
    );
    ApiError::Provider(format!(
        "{} returned an unexpected authorization response.",
        provider.label()
    ))
}

fn database_error(error: sqlx::Error) -> ApiError {
    crate::utils::database_error("agent connection", error)
}

#[cfg(test)]
mod tests;
