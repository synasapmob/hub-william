use crate::{core::ApiError, utils::provider_catalogue::AgentProvider};

mod catalogue;
mod keys;
mod listing_probe;
mod models;
mod providers;
mod proxy;
mod selection;
mod usage;
mod usage_report;
pub(crate) use usage_report::{GatewayUsage, UsageScope, usage_for_user};

pub(crate) use catalogue::{
    current_live_model_id, fetch_or_cached_claude_catalogue, fetch_or_cached_openai_catalogue,
};
// The Playground tests compare their catalogues with these.
#[cfg(test)]
pub(crate) use catalogue::{default_claude_model_catalogue, default_openai_model_catalogue};
pub(crate) use keys::{
    CreatedGatewayKey, GatewayKey, KeyKind, create_key_of_kind, create_ticket_key,
    gateway_key_from_headers, list_keys_of_kind, revoke_key_of_kind,
};
pub(crate) use listing_probe::probe_connection;
pub(crate) use models::{models_for_organization_user, models_for_user};
pub(crate) use providers::gemini_verification::{
    GeminiVerificationProbe, gemini_account_validation_url, probe_gemini_account_verification,
};
pub(crate) use proxy::{
    chatgpt_account_id, response_for_organization_user, response_for_service_user,
    response_for_user,
};
pub(crate) use selection::SERVED_CONNECTION_HEADER;

mod routes;
pub(crate) use routes::{GatewayApi, routes};

mod voice;
pub(crate) use voice::create_voice_session_for_user;

const OPENAI_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

const CLAUDE_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
// Match the installed OpenCode/OMP gateway installers: Claude defaults to only 20 models.
const CLAUDE_COUNT_TOKENS_URL: &str = "https://api.anthropic.com/v1/messages/count_tokens";

const GROK_RESPONSES_URL: &str = "https://cli-chat-proxy.grok.com/v1/responses";
const GROK_MODELS_URL: &str = "https://cli-chat-proxy.grok.com/v1/models-v2";

fn upstream_network_error(provider: AgentProvider, error: reqwest::Error) -> ApiError {
    eprintln!("{provider} gateway request failed: {error}");
    ApiError::Provider(format!(
        "The {provider} gateway is temporarily unavailable."
    ))
}

fn database_error(error: sqlx::Error) -> ApiError {
    crate::utils::database_error("gateway", error)
}

#[cfg(test)]
mod tests;
