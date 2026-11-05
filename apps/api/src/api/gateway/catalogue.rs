//! Live model catalogues read from the provider documentation, and the filter that
//! keeps only current models.

use std::sync::{OnceLock, RwLock};
use std::time::{Duration as StdDuration, Instant};

use axum::{
    body::{Body, to_bytes},
    http::{HeaderValue, header},
    response::Response,
};
use serde_json::{Value, json};

use crate::{core::ApiError, utils::provider_catalogue::AgentProvider};

const DOCS_CACHE_TTL: StdDuration = StdDuration::from_secs(3600);

pub(super) static CLAUDE_DOCS_CACHE: OnceLock<RwLock<(Instant, Value)>> = OnceLock::new();
pub(super) static OPENAI_DOCS_CACHE: OnceLock<RwLock<(Instant, Value)>> = OnceLock::new();

/// Keeps the current catalogue entries that the live account also lists.
/// Hidden and inactive live entries do not count as available.
pub(crate) fn intersect_live_catalogue(current: &Value, live: &Value) -> Result<Value, ApiError> {
    let entries = live
        .get("data")
        .or_else(|| live.get("models"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ApiError::Provider("The provider returned an invalid model catalogue.".to_owned())
        })?;
    let available: Vec<&str> = entries
        .iter()
        .filter(|entry| entry.get("active") != Some(&Value::Bool(false)))
        .filter(|entry| {
            !entry
                .get("visibility")
                .and_then(Value::as_str)
                .is_some_and(|visibility| {
                    visibility.eq_ignore_ascii_case("hide")
                        || visibility.eq_ignore_ascii_case("hidden")
                })
        })
        .filter_map(|entry| {
            entry
                .get("slug")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str)
        })
        .collect();
    let mut catalogue = current.clone();
    if let Some(models) = catalogue.get_mut("data").and_then(Value::as_array_mut) {
        models.retain(|model| {
            model
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| available.contains(&id))
        });
    }
    Ok(catalogue)
}

pub(crate) fn default_openai_model_catalogue() -> Value {
    crate::utils::provider_catalogue::default_model_catalogue(AgentProvider::Chatgpt)
}

pub(crate) fn parse_openai_models_markdown(content: &str) -> Option<Value> {
    let recommended = content.split_once("## Recommended models")?.1;
    let recommended = recommended.split("\n## ").next().unwrap_or(recommended);
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in recommended.lines() {
        let trimmed = line.trim();
        let Some(model_id) = trimmed
            .strip_prefix("slug=\"")
            .and_then(|value| value.strip_suffix('"'))
        else {
            continue;
        };
        push_openai_model(&mut models, &mut seen, model_id);
    }

    // The older generation remains current during rollout, but has no ModelDetails
    // block. Read only the explicit rollout paragraph in the recommended section.
    if let Some(rollout) = recommended
        .split("\n\n")
        .find(|paragraph| paragraph.contains("remain available during the rollout"))
    {
        for fragment in rollout.split("GPT-").skip(1) {
            let mut words = fragment.split_whitespace();
            let (Some(version), Some(family)) = (words.next(), words.next()) else {
                continue;
            };
            let version = version.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
            let family = family.trim_matches(|c: char| !c.is_ascii_alphabetic());
            if version.chars().any(|c| c.is_ascii_digit()) && !family.is_empty() {
                let model_id = format!("gpt-{version}-{}", family.to_ascii_lowercase());
                push_openai_model(&mut models, &mut seen, &model_id);
            }
        }
    }

    if models.is_empty() {
        None
    } else {
        Some(json!({ "object": "list", "data": models }))
    }
}

fn push_openai_model(
    models: &mut Vec<Value>,
    seen: &mut std::collections::HashSet<String>,
    id: &str,
) {
    if !id.starts_with("gpt-") || !seen.insert(id.to_owned()) {
        return;
    }
    let suffix = id.strip_prefix("gpt-").unwrap_or(id);
    let name = format!(
        "GPT-{}",
        suffix
            .split('-')
            .enumerate()
            .map(|(index, part)| {
                if index == 0 {
                    part.to_owned()
                } else {
                    let mut chars = part.chars();
                    match chars.next() {
                        Some(first) => first.to_uppercase().chain(chars).collect(),
                        None => String::new(),
                    }
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    );
    models.push(json!({"id": id, "name": name, "object": "model", "owned_by": "openai"}));
}

pub(crate) async fn fetch_or_cached_openai_catalogue(http: &reqwest::Client) -> Value {
    let cache = OPENAI_DOCS_CACHE.get_or_init(|| {
        RwLock::new((
            Instant::now()
                .checked_sub(DOCS_CACHE_TTL)
                .unwrap_or_else(Instant::now),
            Value::Null,
        ))
    });
    if let Some(cached) = cache.read().ok().and_then(|g| {
        if g.0.elapsed() < DOCS_CACHE_TTL && !g.1.is_null() {
            Some(g.1.clone())
        } else {
            None
        }
    }) {
        return cached;
    }

    let fetched = async {
        let response = http
            .get(
                &crate::utils::provider_catalogue::provider(AgentProvider::Chatgpt)
                    .discovery
                    .docs_url,
            )
            .timeout(StdDuration::from_secs(6))
            .header("User-Agent", "hub-william")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let text = response.text().await.ok()?;
        parse_openai_models_markdown(&text)
    }
    .await;

    if let Some(catalogue) = fetched {
        if let Ok(mut guard) = cache.write() {
            *guard = (Instant::now(), catalogue.clone());
        }
        return catalogue;
    }

    if let Some(stale) = cache.read().ok().and_then(|g| {
        if !g.1.is_null() {
            Some(g.1.clone())
        } else {
            None
        }
    }) {
        return stale;
    }
    default_openai_model_catalogue()
}

pub(crate) fn default_claude_model_catalogue() -> Value {
    crate::utils::provider_catalogue::default_model_catalogue(AgentProvider::Claude)
}

pub(crate) fn parse_claude_models_markdown(content: &str) -> Option<Value> {
    let current = content.split_once("## Compare models")?.1;
    let current = current.split("\n## ").next().unwrap_or(current);
    let mut header_cols: Vec<String> = Vec::new();
    let mut id_cols: Vec<String> = Vec::new();
    let mut effort_cols: Vec<String> = Vec::new();

    for line in current.lines() {
        let parts: Vec<&str> = line.split('|').map(str::trim).collect();
        if parts.len() > 2 {
            let label = parts[1].trim_start_matches('[');
            let label = label.split(']').next().unwrap_or(label).trim();
            if label == "Feature" {
                header_cols = parts[2..parts.len() - 1]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
            } else if label == "Claude API ID" {
                id_cols = parts[2..parts.len() - 1]
                    .iter()
                    .map(|s| s.trim_matches(|c| c == '`' || c == ' ').to_string())
                    .collect();
            } else if label == "Default effort" {
                effort_cols = parts[2..parts.len() - 1]
                    .iter()
                    .map(|s| s.trim_matches(|c| c == '`' || c == ' ').to_string())
                    .collect();
            }
        }
    }

    if id_cols.is_empty() {
        return None;
    }

    let standard_effort = crate::utils::provider_catalogue::effort_capability(
        &crate::utils::provider_catalogue::provider(AgentProvider::Claude)
            .models
            .iter()
            .find(|model| !model.reasoning_efforts.is_empty())
            .map(|model| model.reasoning_efforts.clone())
            .unwrap_or_default(),
    );

    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for (i, mid) in id_cols.into_iter().enumerate() {
        if mid.is_empty() || seen.contains(&mid) {
            continue;
        }
        seen.insert(mid.clone());
        let name = header_cols.get(i).cloned().unwrap_or_else(|| mid.clone());
        let effort_supported = effort_cols
            .get(i)
            .map(|e| !e.eq_ignore_ascii_case("not supported") && !e.is_empty())
            .unwrap_or(false);

        let mut entry = json!({
            "id": mid,
            "display_name": name,
        });
        if effort_supported {
            entry["capabilities"] = json!({ "effort": standard_effort });
        }
        models.push(entry);
    }

    if models.is_empty() {
        None
    } else {
        Some(json!({ "object": "list", "data": models }))
    }
}

pub(crate) async fn fetch_or_cached_claude_catalogue(http: &reqwest::Client) -> Value {
    let cache = CLAUDE_DOCS_CACHE.get_or_init(|| {
        RwLock::new((
            Instant::now()
                .checked_sub(DOCS_CACHE_TTL)
                .unwrap_or_else(Instant::now),
            Value::Null,
        ))
    });
    if let Some(cached) = cache.read().ok().and_then(|g| {
        if g.0.elapsed() < DOCS_CACHE_TTL && !g.1.is_null() {
            Some(g.1.clone())
        } else {
            None
        }
    }) {
        return cached;
    }

    let fetched = async {
        let response = http
            .get(
                &crate::utils::provider_catalogue::provider(AgentProvider::Claude)
                    .discovery
                    .docs_url,
            )
            .timeout(StdDuration::from_secs(6))
            .header("User-Agent", "hub-william")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let text = response.text().await.ok()?;
        parse_claude_models_markdown(&text)
    }
    .await;

    if let Some(catalogue) = fetched {
        if let Ok(mut guard) = cache.write() {
            *guard = (Instant::now(), catalogue.clone());
        }
        return catalogue;
    }

    if let Some(stale) = cache.read().ok().and_then(|g| {
        if !g.1.is_null() {
            Some(g.1.clone())
        } else {
            None
        }
    }) {
        return stale;
    }
    default_claude_model_catalogue()
}

pub(crate) fn current_live_model_id(provider: AgentProvider, id: &str) -> bool {
    crate::utils::provider_catalogue::current_chat_model(provider, id)
}

pub(super) fn filter_current_live_model_catalogue(
    payload: &mut Value,
    provider: AgentProvider,
) -> Result<(), ApiError> {
    let key = if payload.get("data").is_some() {
        "data"
    } else {
        "models"
    };
    let models = payload
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            ApiError::Provider("The provider returned an invalid model catalogue.".to_owned())
        })?;
    models.retain(|model| {
        model
            .get("id")
            .or_else(|| model.get("slug"))
            .and_then(Value::as_str)
            .is_some_and(|id| current_live_model_id(provider, id))
    });
    Ok(())
}

pub(super) async fn filter_current_live_model_response(
    response: Response,
    provider: AgentProvider,
) -> Result<Response, ApiError> {
    if !response.status().is_success() {
        return Ok(response);
    }
    let (mut parts, body) = response.into_parts();
    let bytes = to_bytes(body, 8 * 1024 * 1024)
        .await
        .map_err(|_| ApiError::Provider("The model catalogue could not be read.".to_owned()))?;
    let mut payload: Value = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::Provider("The provider returned an invalid model catalogue.".to_owned())
    })?;
    filter_current_live_model_catalogue(&mut payload, provider)?;
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.remove(header::CONTENT_ENCODING);
    parts.headers.remove(header::ETAG);
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(Response::from_parts(
        parts,
        Body::from(serde_json::to_vec(&payload).map_err(|_| ApiError::Internal)?),
    ))
}
