use axum::{
    Json,
    body::{Bytes, to_bytes},
    extract::{Extension, Path, Query, Request, State},
    http::header,
    middleware::Next,
    response::Response,
};
use axum_extra::extract::CookieJar;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    api::{auth::authenticated_user_id, gateway, limits::SessionUserId},
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

mod routes;
mod voice;
pub(crate) use routes::{PlaygroundApi, routes};

#[derive(Serialize, ToSchema)]
pub struct PlaygroundModel {
    pub id: String,
    pub name: String,
    pub modes: Vec<PlaygroundMode>,
    pub capabilities: Vec<crate::utils::provider_catalogue::ModelCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call: Option<crate::utils::provider_catalogue::CallProfile>,
}

#[derive(Serialize, ToSchema, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PlaygroundMode {
    Chat,
    Voice,
}

#[derive(Clone, Copy, Deserialize, Serialize, ToSchema, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PlaygroundRole {
    User,
    Assistant,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PlaygroundMessage {
    pub role: PlaygroundRole,
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<PlaygroundAttachment>,
}

#[derive(Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PlaygroundAttachment {
    Image {
        name: String,
        media_type: String,
        data: String,
    },
    Text {
        name: String,
        text: String,
    },
}

#[derive(Clone, Copy)]
pub struct PlaygroundSession(pub(crate) Uuid);

/// Authenticate before Axum buffers or deserializes potentially large uploads.
pub async fn authorize_chat(
    State(state): State<AppState>,
    jar: CookieJar,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .ok_or(ApiError::Forbidden)?;
    if !crate::core::browser_origins(&state.config).contains(origin) {
        return Err(ApiError::Forbidden);
    }
    request.extensions_mut().insert(PlaygroundSession(user_id));
    request.extensions_mut().insert(SessionUserId(user_id));
    Ok(next.run(request).await)
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PlaygroundChatRequest {
    /// The account to try first. A Service chat has none: the platform's stock
    /// serves it.
    pub connection_id: Option<Uuid>,
    pub organization_id: Option<Uuid>,
    /// Chat in the Service's scope: charged to the wallet, served by the stock.
    #[serde(default)]
    pub service: bool,
    pub provider: AgentProvider,
    pub model: String,
    pub messages: Vec<PlaygroundMessage>,
}

#[derive(Deserialize, ToSchema)]
pub struct PlaygroundModelsQuery {
    pub organization_id: Option<Uuid>,
}

#[utoipa::path(get, path = "/playground/{provider}/accounts/{connection_id}/models", params(("provider" = AgentProvider, Path), ("connection_id" = Uuid, Path), ("organization_id" = Option<Uuid>, Query, description = "Organization whose shared agent should be used")), responses(
    (status = 200, body = [PlaygroundModel]),
    (status = 401, body = crate::core::ErrorResponse),
    (status = 403, body = crate::core::ErrorResponse),
    (status = 502, body = crate::core::ErrorResponse)
), tag = "playground")]
pub async fn models(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((provider, connection_id)): Path<(AgentProvider, Uuid)>,
    Query(query): Query<PlaygroundModelsQuery>,
) -> Result<Json<Vec<PlaygroundModel>>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let response = if let Some(organization_id) = query.organization_id {
        gateway::models_for_organization_user(
            &state,
            user_id,
            organization_id,
            connection_id,
            provider,
        )
        .await?
    } else {
        gateway::models_for_user(&state, user_id, connection_id, provider).await?
    };
    if !response.status().is_success() {
        return Err(ApiError::Provider(format!(
            "{} model discovery returned HTTP {}.",
            provider.label(),
            response.status().as_u16()
        )));
    }
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .map_err(|_| ApiError::Provider("The model catalogue could not be read.".to_owned()))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::Provider("The provider returned an invalid model catalogue.".to_owned())
    })?;
    let current_catalogue = match provider {
        AgentProvider::Chatgpt => {
            Some(gateway::fetch_or_cached_openai_catalogue(&state.http).await)
        }
        AgentProvider::Claude => Some(gateway::fetch_or_cached_claude_catalogue(&state.http).await),
        _ => None,
    };
    let mut models = normalize_models(provider, &value, current_catalogue.as_ref())?;
    let has_chat_models = !models.is_empty();
    for call in crate::utils::provider_catalogue::call_profiles(provider) {
        if crate::utils::provider_catalogue::call_available(call, has_chat_models) {
            if let Some(model) = models
                .iter_mut()
                .find(|model| model.id == call.selector_model)
            {
                model.modes.push(PlaygroundMode::Voice);
                model.call = Some(call.clone());
                continue;
            }
            models.push(PlaygroundModel {
                id: call.selector_model.clone(),
                name: call.name.clone(),
                modes: vec![PlaygroundMode::Voice],
                capabilities: crate::utils::provider_catalogue::provider(provider)
                    .capabilities(&call.selector_model),
                call: Some(call.clone()),
            });
        }
    }
    Ok(Json(models))
}

// The picker intersects the chosen account's live models with the same current
// catalogue used by gateway installers. Grok and DeepSeek are filtered at the
// gateway boundary as well so every client sees their current lineup.
fn current_playground_model(
    provider: AgentProvider,
    id: &str,
    current_catalogue: Option<&Value>,
) -> bool {
    match crate::utils::provider_catalogue::provider(provider)
        .discovery
        .strategy
        .as_str()
    {
        "official_docs" => current_catalogue
            .and_then(|catalogue| catalogue.get("data"))
            .and_then(Value::as_array)
            .is_some_and(|models| models.iter().any(|model| model["id"] == id)),
        _ => crate::utils::provider_catalogue::current_chat_model(provider, id),
    }
}

fn normalize_models(
    provider: AgentProvider,
    value: &Value,
    current_catalogue: Option<&Value>,
) -> Result<Vec<PlaygroundModel>, ApiError> {
    let entries = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ApiError::Provider("The provider returned an invalid model catalogue.".to_owned())
        })?;
    let mut models = Vec::new();
    for entry in entries {
        let Some(id) = entry
            .get("slug")
            .or_else(|| entry.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
        else {
            continue;
        };
        if entry.get("active") == Some(&Value::Bool(false))
            || !current_playground_model(provider, id, current_catalogue)
        {
            continue;
        }
        if entry
            .get("visibility")
            .and_then(Value::as_str)
            .is_some_and(|visibility| {
                visibility.eq_ignore_ascii_case("hide") || visibility.eq_ignore_ascii_case("hidden")
            })
        {
            continue;
        }
        if models.iter().any(|model: &PlaygroundModel| model.id == id) {
            continue;
        }
        let name = entry
            .get("display_name")
            .or_else(|| entry.get("name"))
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or(id);
        models.push(PlaygroundModel {
            id: id.to_owned(),
            name: name.to_owned(),
            modes: vec![PlaygroundMode::Chat],
            capabilities: crate::utils::provider_catalogue::provider(provider).capabilities(id),
            call: None,
        });
    }
    Ok(models)
}

#[utoipa::path(post, path = "/playground/chat", request_body = PlaygroundChatRequest, responses(
    (status = 200, description = "Provider-native text event stream", body = String, content_type = "text/event-stream"),
    (status = 401, body = crate::core::ErrorResponse),
    (status = 403, body = crate::core::ErrorResponse),
    (status = 422, body = crate::core::ErrorResponse),
    (status = 429, body = crate::core::ErrorResponse),
    (status = 502, body = crate::core::ErrorResponse)
), tag = "playground")]
pub async fn chat(
    State(state): State<AppState>,
    Extension(session): Extension<PlaygroundSession>,
    Json(request): Json<PlaygroundChatRequest>,
) -> Result<Response, ApiError> {
    if crate::utils::provider_catalogue::call_profile(request.provider, &request.model).is_some()
        && !crate::utils::provider_catalogue::provider(request.provider)
            .capabilities(&request.model)
            .contains(&crate::utils::provider_catalogue::ModelCapability::Chat)
    {
        return Err(ApiError::Validation("Select Call to use this voice model."));
    }
    let body = request_body(&request)?;
    let bytes = serde_json::to_vec(&body)
        .map(Bytes::from)
        .map_err(|_| ApiError::Internal)?;
    if request.service {
        if request.connection_id.is_some() || request.organization_id.is_some() {
            return Err(ApiError::Validation(
                "A Service chat has no account or organization of its own.",
            ));
        }
        return gateway::response_for_service_user(
            &state,
            session.0,
            request.provider,
            &request.model,
            bytes,
        )
        .await;
    }
    let connection_id = request
        .connection_id
        .ok_or(ApiError::Validation("Select an account."))?;
    if let Some(organization_id) = request.organization_id {
        gateway::response_for_organization_user(
            &state,
            session.0,
            organization_id,
            connection_id,
            request.provider,
            &request.model,
            bytes,
        )
        .await
    } else {
        gateway::response_for_user(
            &state,
            session.0,
            connection_id,
            request.provider,
            &request.model,
            bytes,
        )
        .await
    }
}

fn attachment_text(attachment: &PlaygroundAttachment) -> Option<String> {
    match attachment {
        PlaygroundAttachment::Text { name, text } => Some(format!("Attached file: {name}\n{text}")),
        PlaygroundAttachment::Image { .. } => None,
    }
}

fn validate_attachment(
    attachment: &PlaygroundAttachment,
    provider: AgentProvider,
) -> Result<(), ApiError> {
    const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;
    match attachment {
        PlaygroundAttachment::Text { name, text } => {
            if name.is_empty()
                || name.len() > 1024
                || text.trim().is_empty()
                || text.len() > MAX_FILE_BYTES
            {
                return Err(ApiError::Validation(
                    "Attach a nonempty text file up to 5 MB.",
                ));
            }
        }
        PlaygroundAttachment::Image {
            name,
            media_type,
            data,
        } => {
            if !crate::utils::provider_catalogue::provider(provider)
                .chat_capabilities
                .contains(&crate::utils::provider_catalogue::ModelCapability::ImageInput)
            {
                return Err(ApiError::Validation(
                    "This Playground provider supports text files, but image input is not supported yet.",
                ));
            }
            if name.is_empty() || name.len() > 1024 || data.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
                return Err(ApiError::Validation("Attach an image up to 5 MB."));
            }
            let bytes = STANDARD
                .decode(data)
                .map_err(|_| ApiError::Validation("The image data is invalid."))?;
            let valid = match media_type.as_str() {
                "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
                "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
                "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
                _ => false,
            };
            if !valid || bytes.len() > MAX_FILE_BYTES {
                return Err(ApiError::Validation(
                    "Use a valid PNG, JPEG, GIF or WebP image up to 5 MB.",
                ));
            }
        }
    }
    Ok(())
}

fn request_body(request: &PlaygroundChatRequest) -> Result<Value, ApiError> {
    let valid_model = if request.provider == AgentProvider::Groq {
        gateway::current_live_model_id(request.provider, &request.model)
    } else {
        !request.model.trim().is_empty() && !request.model.contains(['/', ':'])
    };
    if !valid_model {
        return Err(ApiError::Validation("Choose a valid model."));
    }
    if request.messages.is_empty()
        || request.messages.len().is_multiple_of(2)
        || request.messages.iter().enumerate().any(|(index, message)| {
            let expected = if index % 2 == 0 {
                PlaygroundRole::User
            } else {
                PlaygroundRole::Assistant
            };
            message.role != expected
                || (message.content.trim().is_empty() && message.attachments.is_empty())
                || (message.role == PlaygroundRole::Assistant && !message.attachments.is_empty())
                || message.attachments.len() > 4
        })
    {
        return Err(ApiError::Validation(
            "Provide alternating user and assistant messages ending with a user message.",
        ));
    }
    for message in &request.messages {
        for attachment in &message.attachments {
            validate_attachment(attachment, request.provider)?;
        }
    }
    let messages: Vec<Value> = request.messages.iter().map(|message| {
        let mut content = Vec::new();
        if !message.content.is_empty() {
            content.push(if request.provider == AgentProvider::Claude { json!({"type":"text", "text":message.content}) } else { json!({"type":"input_text", "text":message.content}) });
        }
        for attachment in &message.attachments {
            if let Some(text) = attachment_text(attachment) {
                content.push(if request.provider == AgentProvider::Claude { json!({"type":"text", "text":text}) } else { json!({"type":"input_text", "text":text}) });
            } else if let PlaygroundAttachment::Image { media_type, data, .. } = attachment {
                content.push(if request.provider == AgentProvider::Claude {
                    json!({"type":"image", "source":{"type":"base64", "media_type":media_type, "data":data}})
                } else { json!({"type":"input_image", "image_url":format!("data:{media_type};base64,{data}"), "detail":"auto"}) });
            }
        }
        if message.role == PlaygroundRole::Assistant { json!({"role":message.role, "content":message.content}) }
        else { json!({"role":message.role, "content":content}) }
    }).collect();
    Ok(match request.provider {
        AgentProvider::Claude => {
            json!({ "model": request.model, "messages": messages, "stream": true, "max_tokens": 4096 })
        }
        AgentProvider::Gemini => json!({ "contents": request.messages.iter().map(|message| {
            let mut parts = Vec::new();
            if !message.content.is_empty() { parts.push(json!({"text":message.content})); }
            for attachment in &message.attachments {
                if let Some(text) = attachment_text(attachment) { parts.push(json!({"text":text})); }
                else if let PlaygroundAttachment::Image { media_type, data, .. } = attachment { parts.push(json!({"inlineData":{"mimeType":media_type,"data":data}})); }
            }
            json!({"role": if message.role == PlaygroundRole::User {"user"} else {"model"}, "parts":parts})
        }).collect::<Vec<_>>() }),
        AgentProvider::Groq => {
            json!({ "model": request.model, "input": messages, "stream": true, "instructions": "Answer the user's questions helpfully." })
        }
        AgentProvider::Chatgpt | AgentProvider::Grok | AgentProvider::Deepseek => {
            json!({ "model": request.model, "input": messages, "stream": true, "store": false, "instructions": "Answer the user's questions helpfully." })
        }
    })
}

#[cfg(test)]
mod tests;

#[cfg(all(test, feature = "database-tests"))]
mod database_tests;
