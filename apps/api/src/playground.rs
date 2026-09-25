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

use crate::{AgentProvider, AppState, auth::authenticated_user_id, error::ApiError, gateway};

#[derive(Serialize, ToSchema)]
pub struct PlaygroundModel {
    pub id: String,
    pub name: String,
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
pub struct PlaygroundSession(Uuid);

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
    if !crate::browser_origins(&state.config).contains(origin) {
        return Err(ApiError::Forbidden);
    }
    request.extensions_mut().insert(PlaygroundSession(user_id));
    Ok(next.run(request).await)
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PlaygroundChatRequest {
    pub connection_id: Uuid,
    pub organization_id: Option<Uuid>,
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
    (status = 401, body = crate::ErrorResponse),
    (status = 403, body = crate::ErrorResponse),
    (status = 502, body = crate::ErrorResponse)
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
    Ok(Json(normalize_models(
        provider,
        &value,
        current_catalogue.as_ref(),
    )?))
}

// The picker intersects the chosen account's live models with the same current
// catalogue used by gateway installers. Grok and DeepSeek are filtered at the
// gateway boundary as well so every client sees their current lineup.
fn current_playground_model(
    provider: AgentProvider,
    id: &str,
    current_catalogue: Option<&Value>,
) -> bool {
    match provider {
        AgentProvider::Chatgpt | AgentProvider::Claude => current_catalogue
            .and_then(|catalogue| catalogue.get("data"))
            .and_then(Value::as_array)
            .is_some_and(|models| models.iter().any(|model| model["id"] == id)),
        AgentProvider::Gemini => true,
        AgentProvider::Deepseek | AgentProvider::Grok => {
            gateway::current_live_model_id(provider, id)
        }
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
        if !current_playground_model(provider, id, current_catalogue) {
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
        });
    }
    Ok(models)
}

#[utoipa::path(post, path = "/playground/chat", request_body = PlaygroundChatRequest, responses(
    (status = 200, description = "Provider-native text event stream", body = String, content_type = "text/event-stream"),
    (status = 401, body = crate::ErrorResponse),
    (status = 403, body = crate::ErrorResponse),
    (status = 422, body = crate::ErrorResponse),
    (status = 429, body = crate::ErrorResponse),
    (status = 502, body = crate::ErrorResponse)
), tag = "playground")]
pub async fn chat(
    State(state): State<AppState>,
    Extension(session): Extension<PlaygroundSession>,
    Json(request): Json<PlaygroundChatRequest>,
) -> Result<Response, ApiError> {
    let body = request_body(&request)?;
    let bytes = serde_json::to_vec(&body)
        .map(Bytes::from)
        .map_err(|_| ApiError::Internal)?;
    if let Some(organization_id) = request.organization_id {
        gateway::response_for_organization_user(
            &state,
            session.0,
            organization_id,
            request.connection_id,
            request.provider,
            &request.model,
            bytes,
        )
        .await
    } else {
        gateway::response_for_user(
            &state,
            session.0,
            request.connection_id,
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
            if matches!(provider, AgentProvider::Grok | AgentProvider::Deepseek) {
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
    if request.model.trim().is_empty() || request.model.contains(['/', ':']) {
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
        AgentProvider::Chatgpt | AgentProvider::Grok | AgentProvider::Deepseek => {
            json!({ "model": request.model, "input": messages, "stream": true, "store": false, "instructions": "Answer the user's questions helpfully." })
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(provider: AgentProvider) -> PlaygroundChatRequest {
        PlaygroundChatRequest {
            connection_id: Uuid::new_v4(),
            organization_id: None,
            provider,
            model: "test-model".to_owned(),
            messages: vec![
                PlaygroundMessage {
                    role: PlaygroundRole::User,
                    content: "Hello".to_owned(),
                    attachments: vec![],
                },
                PlaygroundMessage {
                    role: PlaygroundRole::Assistant,
                    content: "Hi".to_owned(),
                    attachments: vec![],
                },
                PlaygroundMessage {
                    role: PlaygroundRole::User,
                    content: "Continue".to_owned(),
                    attachments: vec![],
                },
            ],
        }
    }

    #[test]
    fn native_bodies_preserve_text_and_roles() {
        for provider in [
            AgentProvider::Chatgpt,
            AgentProvider::Grok,
            AgentProvider::Deepseek,
        ] {
            let body = request_body(&request(provider)).unwrap();
            assert_eq!(
                body["input"][1],
                json!({"role":"assistant", "content":"Hi"})
            );
            assert_eq!(body["stream"], true);
            assert_eq!(body["store"], false);
        }
        let claude = request_body(&request(AgentProvider::Claude)).unwrap();
        assert_eq!(claude["messages"][2]["content"][0]["text"], "Continue");
        assert_eq!(claude["max_tokens"], 4096);
        let gemini = request_body(&request(AgentProvider::Gemini)).unwrap();
        assert_eq!(
            gemini["contents"][1],
            json!({"role":"model", "parts":[{"text":"Hi"}]})
        );
    }

    #[test]
    fn rejects_invalid_histories_and_unknown_privileged_fields() {
        let mut input = request(AgentProvider::Chatgpt);
        input.messages.pop();
        assert!(request_body(&input).is_err());
        input.messages.clear();
        assert!(request_body(&input).is_err());
        assert!(serde_json::from_value::<PlaygroundChatRequest>(json!({
            "provider":"chatgpt", "model":"test", "user_id":"other-user", "messages":[{"role":"user", "content":"Hi"}]
        })).is_err());
        assert!(
            serde_json::from_value::<PlaygroundMessage>(json!({"role":"system", "content":"Hi"}))
                .is_err()
        );
    }

    #[test]
    fn native_attachments_are_validated_and_mapped() {
        let image_data = STANDARD.encode(b"\x89PNG\r\n\x1a\n");
        for provider in [
            AgentProvider::Chatgpt,
            AgentProvider::Claude,
            AgentProvider::Gemini,
        ] {
            let mut input = request(provider);
            input.messages[2].attachments = vec![
                PlaygroundAttachment::Text {
                    name: "notes.txt".into(),
                    text: "File content".into(),
                },
                PlaygroundAttachment::Image {
                    name: "image.png".into(),
                    media_type: "image/png".into(),
                    data: image_data.clone(),
                },
            ];
            let body = request_body(&input).unwrap();
            match provider {
                AgentProvider::Claude => {
                    assert_eq!(
                        body["messages"][2]["content"][2]["source"]["data"],
                        image_data
                    );
                    assert_eq!(
                        body["messages"][2]["content"][1]["text"],
                        "Attached file: notes.txt\nFile content"
                    );
                }
                AgentProvider::Gemini => assert_eq!(
                    body["contents"][2]["parts"][2]["inlineData"]["data"],
                    image_data
                ),
                _ => assert_eq!(
                    body["input"][2]["content"][2]["image_url"],
                    format!("data:image/png;base64,{image_data}")
                ),
            }
        }
        let mut input = request(AgentProvider::Deepseek);
        input.messages[2]
            .attachments
            .push(PlaygroundAttachment::Image {
                name: "image.png".into(),
                media_type: "image/png".into(),
                data: image_data,
            });
        assert!(request_body(&input).is_err());
        input.provider = AgentProvider::Chatgpt;
        input.messages[2].attachments = vec![PlaygroundAttachment::Image {
            name: "fake.png".into(),
            media_type: "image/png".into(),
            data: STANDARD.encode(b"not an image"),
        }];
        assert!(request_body(&input).is_err());
        input.messages[2].attachments = vec![PlaygroundAttachment::Text {
            name: "notes.txt".into(),
            text: "Text only".into(),
        }];
        input.messages[2].content.clear();
        assert!(request_body(&input).is_ok());
    }

    #[test]
    fn catalogue_uses_existing_names_and_deduplicates_ids() {
        let models = normalize_models(AgentProvider::Gemini, &json!({"data":[{"id":"one", "display_name":"One"},{"id":"one"},{"id":"two", "name":"Two"},{"id":"three"},{"name":"invalid"}]}), None).unwrap();
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].name, "One");
        assert_eq!(models[2].name, "three");
        assert!(normalize_models(AgentProvider::Gemini, &json!({"unknown":[]}), None).is_err());
        let codex = normalize_models(
            AgentProvider::Chatgpt,
            &json!({"models":[
                {"id":"internal-id", "slug":"gpt-6-astra", "display_name":"GPT-6 Astra"},
                {"slug":"internal-model", "visibility":"Hidden"},
                {"id":"gpt-5.6-sol", "display_name":"GPT-5.6 Sol"}
            ]}),
            Some(&gateway::default_openai_model_catalogue()),
        )
        .unwrap();
        assert_eq!(codex.len(), 2);
        assert_eq!(codex[0].id, "gpt-6-astra");
        assert_eq!(codex[0].name, "GPT-6 Astra");
        assert_eq!(codex[1].id, "gpt-5.6-sol");
    }

    #[test]
    fn current_lineup_only_includes_ids_advertised_by_selected_account() {
        let claude = normalize_models(
            AgentProvider::Claude,
            &json!({"data":[
                {"id":"claude-opus-4-5-20251101"},
                {"id":"claude-opus-5"},
                {"id":"claude-fable-5-1"},
                {"id":"claude-opus-5-5"},
                {"id":"claude-sonnet-5"},
                {"id":"claude-haiku-4-5-20251001"}
            ]}),
            Some(&gateway::default_claude_model_catalogue()),
        )
        .unwrap();
        assert_eq!(
            claude.into_iter().map(|model| model.id).collect::<Vec<_>>(),
            [
                "claude-fable-5-1",
                "claude-opus-5-5",
                "claude-sonnet-5",
                "claude-haiku-4-5-20251001",
            ]
        );

        let codex = normalize_models(
            AgentProvider::Chatgpt,
            &json!({"models":[
                {"slug":"gpt-5.6-sol"},
                {"slug":"gpt-6-astra"},
                {"slug":"gpt-6-sol"}
            ]}),
            Some(&gateway::default_openai_model_catalogue()),
        )
        .unwrap();
        assert_eq!(
            codex.into_iter().map(|model| model.id).collect::<Vec<_>>(),
            ["gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol"]
        );
    }

    #[test]
    fn newly_documented_model_is_not_blocked_by_a_second_picker_list() {
        let docs = json!({"data": [{"id": "gpt-6-new"}]});
        let models = normalize_models(
            AgentProvider::Chatgpt,
            &json!({"models": [{"slug": "gpt-6-new"}, {"slug": "gpt-5.5"}]}),
            Some(&docs),
        )
        .unwrap();
        assert_eq!(
            models.into_iter().map(|model| model.id).collect::<Vec<_>>(),
            ["gpt-6-new"]
        );
    }
}

#[cfg(all(test, feature = "database-tests"))]
mod database_tests;
