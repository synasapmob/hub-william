use axum::{
    Router,
    extract::DefaultBodyLimit,
    middleware::from_fn_with_state,
    routing::{delete, get, post},
};
use utoipa::OpenApi;

use crate::{
    api::limits::{GatewayLimit, Limit, UserLimit, limit_by_user, limit_gateway},
    core::AppState,
};

use super::{
    claude_count_tokens, claude_messages, claude_models, create_key, deepseek_chat,
    deepseek_models, deepseek_responses, gemini_models, gemini_request, grok_chat, grok_models,
    grok_responses, groq_chat, groq_models, groq_responses, list_keys, openai_models,
    openai_responses, revoke_key,
};

pub(crate) fn routes(state: &AppState) -> Router<AppState> {
    let manage = UserLimit::new(state, Limit::GatewayKeyManagement);

    Router::new()
        .route(
            "/gateway-keys",
            get(list_keys)
                .merge(post(create_key).layer(from_fn_with_state(manage.clone(), limit_by_user))),
        )
        .route(
            "/gateway-keys/{key_id}",
            delete(revoke_key).layer(from_fn_with_state(manage, limit_by_user)),
        )
        .merge(provider_routes(state))
}

/// Provider-compatible endpoints. Prompts carry attachments, so these accept
/// request bodies of any size, unlike the browser API.
fn provider_routes(state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/gateway/openai/v1/responses", post(openai_responses))
        .route("/gateway/openai/v1/models", get(openai_models))
        .route("/gateway/claude/v1/messages", post(claude_messages))
        .route("/gateway/claude/v1/models", get(claude_models))
        .route(
            "/gateway/claude/v1/messages/count_tokens",
            post(claude_count_tokens),
        )
        .route("/gateway/grok/v1/chat/completions", post(grok_chat))
        .route("/gateway/grok/v1/responses", post(grok_responses))
        .route("/gateway/grok/v1/models", get(grok_models))
        .route("/gateway/gemini/v1beta/models", get(gemini_models))
        .route(
            "/gateway/gemini/v1beta/models/{*operation}",
            post(gemini_request),
        )
        .route("/gateway/deepseek/chat/completions", post(deepseek_chat))
        .route("/gateway/deepseek/responses", post(deepseek_responses))
        .route("/gateway/deepseek/models", get(deepseek_models))
        .route("/gateway/groq/v1/models", get(groq_models))
        .route("/gateway/groq/v1/responses", post(groq_responses))
        .route("/gateway/groq/v1/chat/completions", post(groq_chat))
        .layer(DefaultBodyLimit::disable())
        .layer(from_fn_with_state(GatewayLimit::new(state), limit_gateway))
}

#[derive(OpenApi)]
#[openapi(
    paths(super::create_key, super::list_keys, super::revoke_key),
    components(schemas(super::CreatedGatewayKey, super::GatewayKey)),
    tags((name = "gateway keys", description = "Revocable keys for provider-specific gateway access"))
)]
pub(crate) struct GatewayApi;
