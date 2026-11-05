//! Token usage read from upstream responses, and the organization usage events
//! recorded from it.

use serde_json::Value;
use uuid::Uuid;

use super::selection::GatewaySelection;
use crate::{core::AppState, utils::provider_catalogue::AgentProvider};

#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub(super) struct TokenUsage {
    pub(super) input_tokens: Option<i64>,
    pub(super) output_tokens: Option<i64>,
    pub(super) cached_tokens: Option<i64>,
}

impl TokenUsage {
    pub(super) fn has_tokens(self) -> bool {
        self.input_tokens.is_some() || self.output_tokens.is_some() || self.cached_tokens.is_some()
    }
}

pub(super) const MAX_USAGE_PAYLOAD_BYTES: usize = 1024 * 1024;

pub(super) struct UsageObserver {
    provider: AgentProvider,
    sse: bool,
    pub(super) pending: Vec<u8>,
    event_data: Vec<u8>,
    overflow: bool,
    skip_event: bool,
    pub(super) completed: bool,
    failed: bool,
    pub(super) usage: TokenUsage,
    claude_stop_reason: Option<String>,
    chat_completion_finished: bool,
    claude_input_tokens: Option<i64>,
    claude_cache_read_tokens: Option<i64>,
    claude_cache_creation_tokens: Option<i64>,
}

impl UsageObserver {
    pub(super) fn new(provider: AgentProvider, sse: bool) -> Self {
        Self {
            provider,
            sse,
            pending: Vec::new(),
            event_data: Vec::new(),
            overflow: false,
            skip_event: false,
            completed: false,
            failed: false,
            usage: TokenUsage::default(),
            claude_stop_reason: None,
            chat_completion_finished: false,
            claude_input_tokens: None,
            claude_cache_read_tokens: None,
            claude_cache_creation_tokens: None,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) {
        if !self.sse {
            if !self.overflow
                && self.pending.len().saturating_add(bytes.len()) <= MAX_USAGE_PAYLOAD_BYTES
            {
                self.pending.extend_from_slice(bytes);
            } else {
                self.pending.clear();
                self.overflow = true;
            }
            return;
        }

        for &byte in bytes {
            if byte == b'\n' {
                if !self.overflow {
                    let line = std::mem::take(&mut self.pending);
                    self.read_sse_line(&line);
                } else {
                    self.pending.clear();
                    self.overflow = false;
                    self.event_data.clear();
                    self.skip_event = true;
                }
            } else if self.pending.len() < MAX_USAGE_PAYLOAD_BYTES {
                self.pending.push(byte);
            } else {
                self.overflow = true;
            }
        }
    }

    fn read_sse_line(&mut self, line: &[u8]) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            if !self.skip_event {
                self.read_event();
            }
            self.skip_event = false;
            self.event_data.clear();
            return;
        }
        if self.skip_event {
            return;
        }
        let Some(data) = line.strip_prefix(b"data:") else {
            return;
        };
        let data = data.strip_prefix(b" ").unwrap_or(data);
        if data == b"[DONE]" {
            if self.chat_completion_finished && !self.failed {
                self.completed = true;
            }
            return;
        }
        if self
            .event_data
            .len()
            .saturating_add(data.len())
            .saturating_add(1)
            > MAX_USAGE_PAYLOAD_BYTES
        {
            self.event_data.clear();
            self.skip_event = true;
            return;
        }
        if !self.event_data.is_empty() {
            self.event_data.push(b'\n');
        }
        self.event_data.extend_from_slice(data);
    }

    fn read_event(&mut self) {
        if self.event_data.is_empty() {
            return;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&self.event_data) {
            self.read_value(&value);
        }
        self.event_data.clear();
    }

    pub(super) fn read_value(&mut self, value: &Value) {
        match self.provider {
            AgentProvider::Claude => match value.get("type").and_then(Value::as_str) {
                Some("message_start") => self.read_claude_usage(value.pointer("/message/usage")),
                Some("message_delta") => {
                    self.read_claude_usage(value.get("usage"));
                    if let Some(reason) =
                        value.pointer("/delta/stop_reason").and_then(Value::as_str)
                    {
                        self.claude_stop_reason = Some(reason.to_owned());
                    }
                }
                Some("message_stop") => {
                    self.completed = matches!(
                        self.claude_stop_reason.as_deref(),
                        Some("end_turn" | "stop_sequence" | "refusal")
                    );
                }
                _ if !self.sse => {
                    self.read_claude_usage(value.get("usage"));
                    self.completed = matches!(
                        value.get("stop_reason").and_then(Value::as_str),
                        Some("end_turn" | "stop_sequence" | "refusal")
                    );
                }
                _ => {}
            },
            AgentProvider::Gemini => {
                let response = value.get("response").unwrap_or(value);
                if response
                    .get("candidates")
                    .and_then(Value::as_array)
                    .is_some_and(|candidates| {
                        candidates.iter().any(|candidate| {
                            candidate.get("index").and_then(Value::as_i64).unwrap_or(0) == 0
                                && candidate.get("finishReason").and_then(Value::as_str)
                                    == Some("STOP")
                        })
                    })
                {
                    self.completed = true;
                }
                let usage = value
                    .pointer("/response/usageMetadata")
                    .or_else(|| value.get("usageMetadata"))
                    .filter(|usage| usage.is_object());
                if let Some(usage) = usage {
                    if let Some(input) = nonnegative_i64(usage.get("promptTokenCount")) {
                        self.usage.input_tokens = Some(input);
                    }
                    if let Some(cached) = nonnegative_i64(usage.get("cachedContentTokenCount")) {
                        self.usage.cached_tokens = Some(cached);
                    }
                    if let Some(output) = nonnegative_i64(usage.get("totalTokenCount"))
                        .and_then(|total| {
                            self.usage
                                .input_tokens
                                .and_then(|input| total.checked_sub(input))
                        })
                        .or_else(|| {
                            nonnegative_i64(usage.get("candidatesTokenCount")).and_then(
                                |candidate| {
                                    candidate.checked_add(
                                        nonnegative_i64(usage.get("thoughtsTokenCount"))
                                            .unwrap_or(0),
                                    )
                                },
                            )
                        })
                    {
                        self.usage.output_tokens = Some(output);
                    }
                }
            }
            AgentProvider::Chatgpt
            | AgentProvider::Grok
            | AgentProvider::Deepseek
            | AgentProvider::Groq => {
                if matches!(
                    value.get("status").and_then(Value::as_str),
                    Some("failed" | "incomplete")
                ) {
                    self.failed = true;
                    self.completed = false;
                }
                match value.get("type").and_then(Value::as_str) {
                    Some("response.completed") if !self.failed => self.completed = true,
                    Some("response.failed" | "response.incomplete") => {
                        self.completed = false;
                        self.failed = true;
                    }
                    _ => {}
                }
                if value
                    .get("choices")
                    .and_then(Value::as_array)
                    .is_some_and(|choices| {
                        choices.iter().any(|choice| {
                            matches!(
                                choice.get("finish_reason").and_then(Value::as_str),
                                Some("stop" | "tool_calls" | "function_call")
                            )
                        })
                    })
                {
                    self.chat_completion_finished = true;
                }
                let usage = value
                    .pointer("/response/usage")
                    .or_else(|| value.get("usage"))
                    .filter(|usage| usage.is_object());
                if let Some(usage) = usage {
                    if let Some(input) = nonnegative_i64(usage.get("input_tokens"))
                        .or_else(|| nonnegative_i64(usage.get("prompt_tokens")))
                    {
                        self.usage.input_tokens = Some(input);
                    }
                    if let Some(output) = nonnegative_i64(usage.get("output_tokens"))
                        .or_else(|| nonnegative_i64(usage.get("completion_tokens")))
                    {
                        self.usage.output_tokens = Some(output);
                    }
                    if let Some(cached) =
                        nonnegative_i64(usage.pointer("/input_tokens_details/cached_tokens"))
                            .or_else(|| {
                                nonnegative_i64(
                                    usage.pointer("/prompt_tokens_details/cached_tokens"),
                                )
                            })
                    {
                        self.usage.cached_tokens = Some(cached);
                    }
                }
            }
        }
    }

    fn read_claude_usage(&mut self, usage: Option<&Value>) {
        let Some(usage) = usage else { return };
        if let Some(input) = nonnegative_i64(usage.get("input_tokens")) {
            self.claude_input_tokens = Some(input);
        }
        if let Some(cache_read) = nonnegative_i64(usage.get("cache_read_input_tokens")) {
            self.claude_cache_read_tokens = Some(cache_read);
            self.usage.cached_tokens = Some(cache_read);
        }
        if let Some(cache_creation) = nonnegative_i64(usage.get("cache_creation_input_tokens")) {
            self.claude_cache_creation_tokens = Some(cache_creation);
        }
        self.usage.input_tokens = self
            .claude_input_tokens
            .and_then(|input| input.checked_add(self.claude_cache_read_tokens.unwrap_or(0)))
            .and_then(|total| total.checked_add(self.claude_cache_creation_tokens.unwrap_or(0)));
        if let Some(output) = nonnegative_i64(usage.get("output_tokens")) {
            self.usage.output_tokens = Some(output);
        }
    }

    pub(super) fn finish_with_completion(mut self) -> (bool, Option<TokenUsage>) {
        if self.sse {
            if !self.pending.is_empty() && !self.overflow {
                let line = std::mem::take(&mut self.pending);
                self.read_sse_line(&line);
            }
            if !self.skip_event {
                self.read_event();
            }
            if !self.completed || self.failed {
                return (false, None);
            }
        } else if !self.overflow {
            let payload = std::mem::take(&mut self.pending);
            let Ok(value) = serde_json::from_slice::<Value>(&payload) else {
                return (false, None);
            };
            self.read_value(&value);
            if self.failed
                || matches!(self.provider, AgentProvider::Claude | AgentProvider::Gemini)
                    && !self.completed
            {
                return (false, None);
            }
        }
        (true, self.usage.has_tokens().then_some(self.usage))
    }
}

fn nonnegative_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).filter(|value| *value >= 0)
}

#[derive(Clone)]
pub(super) struct OrganizationUsageEvent {
    pub(super) pool: sqlx::PgPool,
    pub(super) organization_id: Uuid,
    pub(super) user_id: Uuid,
    pub(super) connection_id: Uuid,
    pub(super) provider: AgentProvider,
    pub(super) model: Option<String>,
}

pub(super) fn organization_usage_event(
    state: &AppState,
    selection: GatewaySelection,
    connection_id: Uuid,
    provider: AgentProvider,
    model: Option<&str>,
) -> Option<OrganizationUsageEvent> {
    Some(OrganizationUsageEvent {
        pool: state.pool.clone(),
        organization_id: selection.organization_id?,
        user_id: selection.user_id,
        connection_id,
        provider,
        model: model.map(str::to_owned),
    })
}

pub(super) async fn record_organization_usage(
    event: &OrganizationUsageEvent,
    usage: Option<TokenUsage>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO organization_usage_events
         (id, org_id, user_id, connection_id, provider, model,
          input_tokens, output_tokens, cached_tokens)
         VALUES ($1, $2, $3,
                 (SELECT id FROM agent_connections WHERE id = $4 FOR KEY SHARE),
                 $5, $6, $7, $8, $9)",
    )
    .bind(Uuid::new_v4())
    .bind(event.organization_id)
    .bind(event.user_id)
    .bind(event.connection_id)
    .bind(event.provider.to_string())
    .bind(&event.model)
    .bind(usage.and_then(|value| value.input_tokens))
    .bind(usage.and_then(|value| value.output_tokens))
    .bind(usage.and_then(|value| value.cached_tokens))
    .execute(&event.pool)
    .await?;
    Ok(())
}
