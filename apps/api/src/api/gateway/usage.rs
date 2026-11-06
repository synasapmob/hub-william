//! Token usage read from upstream responses, and the usage events recorded from
//! it: one row per generation request in `gateway_usage_events`, plus the
//! organization view of the requests that finished in `organization_usage_events`.

use axum::http::HeaderMap;
use serde_json::{Map, Value};
use uuid::Uuid;

use super::selection::GatewaySelection;
use crate::{
    api::service::{self, ChargedRequest, Tokens},
    core::AppState,
    utils::provider_catalogue::AgentProvider,
};

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
const MAX_QUOTA_EVENT_BYTES: usize = 8 * 1024;
/// Response headers that carry a provider's own quota or rate-limit state.
const QUOTA_HEADER_PREFIXES: [&str; 4] = [
    "x-codex-",
    "anthropic-ratelimit-",
    "x-ratelimit-",
    "ratelimit-",
];

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
    /// The last stream event whose type mentions a rate limit, as received.
    pub(super) quota_event: Option<Value>,
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
            quota_event: None,
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
        if value
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.contains("rate_limit"))
            && value.to_string().len() <= MAX_QUOTA_EVENT_BYTES
        {
            self.quota_event = Some(value.clone());
        }
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

/// What the provider reported about its own quota for one response: the
/// quota-related headers and the rate-limit stream event, exactly as received.
pub(super) fn quota_snapshot(headers: &HeaderMap, event: Option<Value>) -> Option<Value> {
    let headers: Map<String, Value> = headers
        .iter()
        .filter(|(name, _)| {
            QUOTA_HEADER_PREFIXES
                .iter()
                .any(|prefix| name.as_str().starts_with(prefix))
        })
        .filter_map(|(name, value)| {
            Some((
                name.as_str().to_owned(),
                Value::String(value.to_str().ok()?.to_owned()),
            ))
        })
        .collect();
    let mut snapshot = Map::new();
    if !headers.is_empty() {
        snapshot.insert("headers".to_owned(), Value::Object(headers));
    }
    if let Some(event) = event {
        snapshot.insert("event".to_owned(), event);
    }
    (!snapshot.is_empty()).then_some(Value::Object(snapshot))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum UsageOutcome {
    /// The provider finished the response.
    Completed,
    /// The client left, the stream failed, or no completion marker arrived.
    Incomplete,
}

impl UsageOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Incomplete => "incomplete",
        }
    }
}

#[derive(Clone)]
pub(super) struct UsageEvent {
    pub(super) pool: sqlx::PgPool,
    pub(super) user_id: Uuid,
    pub(super) key_id: Option<Uuid>,
    pub(super) organization_id: Option<Uuid>,
    pub(super) connection_id: Uuid,
    pub(super) provider: AgentProvider,
    pub(super) model: Option<String>,
    /// The request is a service key's, so it is charged when it ends.
    pub(super) service: bool,
}

pub(super) fn usage_event(
    state: &AppState,
    selection: GatewaySelection,
    connection_id: Uuid,
    provider: AgentProvider,
    model: Option<&str>,
) -> UsageEvent {
    UsageEvent {
        pool: state.pool.clone(),
        user_id: selection.user_id,
        key_id: selection.key_id,
        organization_id: selection.organization_id,
        connection_id,
        provider,
        model: model.map(str::to_owned),
        service: selection.service,
    }
}

impl UsageEvent {
    /// Records one request in `gateway_usage_events`. When `count_for_organization`
    /// is set and the request belongs to an organization, it also lands in
    /// `organization_usage_events`, which only holds finished requests.
    ///
    /// A request of a service key is charged right after its event is recorded,
    /// once, for that event.
    ///
    /// A failure of the first insert, or of the charge, is logged and never
    /// reaches the caller, so that metering cannot break a response; the
    /// organization insert reports its error as it always did.
    pub(super) async fn record(
        &self,
        outcome: UsageOutcome,
        usage: Option<TokenUsage>,
        quota: Option<Value>,
        count_for_organization: bool,
    ) -> Result<(), sqlx::Error> {
        let event_id = Uuid::new_v4();
        match self
            .insert_gateway_event(event_id, outcome, usage, quota)
            .await
        {
            Ok(()) => self.charge(event_id, usage).await,
            Err(error) => eprintln!("gateway usage insert failed: {error}"),
        }
        if count_for_organization && let Some(organization_id) = self.organization_id {
            self.insert_organization_event(organization_id, usage)
                .await?;
        }
        Ok(())
    }

    /// Which product the request belongs to, whatever sent it.
    fn scope(&self) -> &'static str {
        if self.service {
            "service"
        } else if self.organization_id.is_some() {
            "organization"
        } else {
            "workspace"
        }
    }

    async fn charge(&self, event_id: Uuid, usage: Option<TokenUsage>) {
        if !self.service {
            return;
        }
        let usage = usage.unwrap_or_default();
        let request = ChargedRequest {
            usage_event_id: event_id,
            user_id: self.user_id,
            provider: self.provider,
            model: self.model.as_deref(),
            tokens: Tokens {
                input: usage.input_tokens,
                output: usage.output_tokens,
                cached: usage.cached_tokens,
            },
        };
        if let Err(error) = service::charge_request(&self.pool, request).await {
            eprintln!("service charge failed: {error:?}");
        }
    }

    async fn insert_gateway_event(
        &self,
        event_id: Uuid,
        outcome: UsageOutcome,
        usage: Option<TokenUsage>,
        quota: Option<Value>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO gateway_usage_events
             (id, user_id, gateway_key_id, org_id, connection_id, provider, model,
              input_tokens, output_tokens, cached_tokens, outcome, quota, scope)
             VALUES ($1, $2,
                     (SELECT id FROM gateway_keys WHERE id = $3 FOR KEY SHARE),
                     (SELECT id FROM organizations WHERE id = $4 FOR KEY SHARE),
                     (SELECT id FROM agent_connections WHERE id = $5 FOR KEY SHARE),
                     $6, $7, $8, $9, $10, $11, $12, $13)",
        )
        .bind(event_id)
        .bind(self.user_id)
        .bind(self.key_id)
        .bind(self.organization_id)
        .bind(self.connection_id)
        .bind(self.provider.to_string())
        .bind(&self.model)
        .bind(usage.and_then(|value| value.input_tokens))
        .bind(usage.and_then(|value| value.output_tokens))
        .bind(usage.and_then(|value| value.cached_tokens))
        .bind(outcome.as_str())
        .bind(quota)
        .bind(self.scope())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn insert_organization_event(
        &self,
        organization_id: Uuid,
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
        .bind(organization_id)
        .bind(self.user_id)
        .bind(self.connection_id)
        .bind(self.provider.to_string())
        .bind(&self.model)
        .bind(usage.and_then(|value| value.input_tokens))
        .bind(usage.and_then(|value| value.output_tokens))
        .bind(usage.and_then(|value| value.cached_tokens))
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

/// Watches one response body and records the request when the body ends.
///
/// Records a finished body from [`UsageGuard::finish`]. If the guard is dropped
/// first, because the client closed the connection or the response failed, it
/// records the request as incomplete with whatever usage was seen so far.
pub(super) struct UsageGuard {
    pending: Option<PendingUsage>,
}

struct PendingUsage {
    event: UsageEvent,
    observer: UsageObserver,
    headers: HeaderMap,
    failed: bool,
}

impl UsageGuard {
    pub(super) fn new(event: UsageEvent, observer: UsageObserver, headers: &HeaderMap) -> Self {
        Self {
            pending: Some(PendingUsage {
                event,
                observer,
                headers: headers.clone(),
                failed: false,
            }),
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) {
        if let Some(pending) = self.pending.as_mut() {
            pending.observer.push(bytes);
        }
    }

    /// The upstream stream failed; the request can no longer count as complete.
    pub(super) fn fail(&mut self) {
        if let Some(pending) = self.pending.as_mut() {
            pending.failed = true;
        }
    }

    /// Records the finished request. It runs as a task of its own: a client that
    /// closes the connection the moment it has seen the last chunk drops the
    /// stream, and with it this future, and a request that was served must still
    /// be recorded and, for a service key, charged.
    pub(super) async fn finish(mut self) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        if let Err(error) = tokio::spawn(pending.record_finished()).await {
            eprintln!("gateway usage task failed: {error}");
        }
    }
}

impl PendingUsage {
    async fn record_finished(self) {
        let Self {
            event,
            observer,
            headers,
            failed,
        } = self;
        let quota = quota_snapshot(&headers, observer.quota_event.clone());
        let partial = observer.usage.has_tokens().then_some(observer.usage);
        let (provider_complete, usage) = observer.finish_with_completion();
        let completed = provider_complete && !failed;
        let (outcome, usage) = if completed {
            (UsageOutcome::Completed, usage)
        } else {
            (UsageOutcome::Incomplete, partial)
        };
        if let Err(error) = event.record(outcome, usage, quota, completed).await {
            eprintln!("organization usage insert failed: {error}");
        }
    }
}

impl Drop for UsageGuard {
    fn drop(&mut self) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            let quota = quota_snapshot(&pending.headers, pending.observer.quota_event.clone());
            let usage = pending
                .observer
                .usage
                .has_tokens()
                .then_some(pending.observer.usage);
            if let Err(error) = pending
                .event
                .record(UsageOutcome::Incomplete, usage, quota, false)
                .await
            {
                eprintln!("gateway usage insert failed: {error}");
            }
        });
    }
}
