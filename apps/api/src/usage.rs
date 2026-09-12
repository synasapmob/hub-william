use chrono::{DateTime, Utc};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    AgentPoolUsageMetric, AgentProvider, AppState, connections::provider_credential,
    gateway::chatgpt_account_id,
};

const USAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);
const FIVE_HOUR_SECONDS: i64 = 18_000;
const WEEKLY_SECONDS: i64 = 604_800;

#[derive(Clone, Debug, Default)]
pub struct ShareWindow {
    pub label: String,
    pub reset_at: Option<DateTime<Utc>>,
    pub used_percent: f64,
    pub window_seconds: Option<i64>,
}

#[derive(Debug, Default)]
pub struct ConnectionUsage {
    pub metrics: Vec<AgentPoolUsageMetric>,
    pub windows: Vec<ShareWindow>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TokenCounts {
    pub cached_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

impl TokenCounts {
    pub fn units(self) -> i64 {
        self.cached_tokens
            .saturating_add(self.input_tokens)
            .saturating_add(self.output_tokens)
    }
}

#[derive(Default)]
pub struct UsageExtractor {
    bytes: Vec<u8>,
}

impl UsageExtractor {
    pub fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
    }

    pub fn finish(self) -> Option<TokenCounts> {
        if let Ok(value) = serde_json::from_slice::<Value>(&self.bytes)
            && let Some(counts) = tokens_from_value(&value)
        {
            return Some(counts);
        }
        let text = String::from_utf8_lossy(&self.bytes);
        let mut last = None;
        for line in text.lines() {
            let payload = line
                .trim()
                .strip_prefix("data:")
                .map(str::trim)
                .unwrap_or(line.trim());
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(payload)
                && let Some(counts) = tokens_from_value(&value)
            {
                last = Some(counts);
            }
        }
        last
    }
}

#[derive(Default)]
struct ParsedUsage {
    metrics: Vec<AgentPoolUsageMetric>,
    windows: Vec<ShareWindow>,
}

impl ParsedUsage {
    fn into_connection_usage(self) -> ConnectionUsage {
        ConnectionUsage {
            metrics: self.metrics,
            windows: self.windows,
        }
    }
}

pub async fn for_connection(
    state: &AppState,
    connection_id: Uuid,
    provider: AgentProvider,
) -> ConnectionUsage {
    match tokio::time::timeout(
        USAGE_TIMEOUT,
        fetch_provider_usage(state, connection_id, provider),
    )
    .await
    {
        Ok(usage) if !usage.metrics.is_empty() => usage,
        Ok(_) => ConnectionUsage::default(),
        Err(_) => ConnectionUsage {
            metrics: vec![unavailable("The provider usage request timed out.")],
            windows: Vec::new(),
        },
    }
}

pub async fn record_event(
    state: &AppState,
    connection_id: Uuid,
    user_id: Uuid,
    counts: TokenCounts,
) {
    if counts.units() <= 0 {
        return;
    }
    if let Err(error) = sqlx::query(
        "INSERT INTO agent_pool_usage_events
            (id, connection_id, user_id, input_tokens, output_tokens, cached_tokens)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4())
    .bind(connection_id)
    .bind(user_id)
    .bind(counts.input_tokens)
    .bind(counts.output_tokens)
    .bind(counts.cached_tokens)
    .execute(&state.pool)
    .await
    {
        eprintln!("pool usage event insert failed: {error}");
    }
}

async fn fetch_provider_usage(
    state: &AppState,
    connection_id: Uuid,
    provider: AgentProvider,
) -> ConnectionUsage {
    let token = match provider_credential(state, connection_id).await {
        Ok((_, token)) => token,
        Err(error) => {
            eprintln!("{provider} usage credential refresh failed: {error:?}");
            return ConnectionUsage {
                metrics: vec![unavailable("Could not refresh the provider session.")],
                windows: Vec::new(),
            };
        }
    };
    let Some(access_token) = bearer_token(&token) else {
        return ConnectionUsage {
            metrics: vec![unavailable("The connected account has no access token.")],
            windows: Vec::new(),
        };
    };

    match provider {
        AgentProvider::Chatgpt => chatgpt_usage(state, &token, access_token).await,
        AgentProvider::Claude => claude_usage(state, access_token).await,
        AgentProvider::Grok => grok_usage(state, access_token).await,
    }
}

async fn chatgpt_usage(state: &AppState, token: &Value, access_token: &str) -> ConnectionUsage {
    let mut request = state
        .http
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(access_token)
        .header("user-agent", "codex_cli_rs/0.153.4")
        .header("originator", "codex_cli_rs");
    if let Some(account_id) = chatgpt_account_id(token) {
        request = request.header("chatgpt-account-id", account_id);
    }
    let usage = match send_json(request).await {
        Ok(body) => body,
        Err(detail) => {
            return ConnectionUsage {
                metrics: vec![unavailable(&detail)],
                windows: Vec::new(),
            };
        }
    };
    let mut parsed = parse_chatgpt(&usage);

    let mut credits_request = state
        .http
        .get("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits")
        .bearer_auth(access_token)
        .header("user-agent", "codex_cli_rs/0.153.4");
    if let Some(account_id) = chatgpt_account_id(token) {
        credits_request = credits_request.header("chatgpt-account-id", account_id);
    }
    if let Ok(credits) = send_json(credits_request).await {
        parsed.metrics.extend(parse_chatgpt_reset_credits(&credits));
    }
    parsed.into_connection_usage()
}

async fn claude_usage(state: &AppState, access_token: &str) -> ConnectionUsage {
    let request = state
        .http
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("user-agent", "claude-code/2.1.121")
        .header("accept", "application/json");
    match send_json(request).await {
        Ok(body) => parse_claude(&body).into_connection_usage(),
        Err(detail) => ConnectionUsage {
            metrics: vec![unavailable(&detail)],
            windows: Vec::new(),
        },
    }
}

async fn grok_usage(state: &AppState, access_token: &str) -> ConnectionUsage {
    let request = state
        .http
        .get("https://cli-chat-proxy.grok.com/v1/billing?format=credits")
        .bearer_auth(access_token)
        .header("x-xai-token-auth", "xai-grok-cli")
        .header("x-grok-client-version", "1.0.13")
        .header("x-grok-client-identifier", "grok-shell")
        .header("user-agent", "xai-grok-build/1.0.13");
    match send_json(request).await {
        Ok(body) => parse_grok(&body).into_connection_usage(),
        Err(detail) => ConnectionUsage {
            metrics: vec![unavailable(&detail)],
            windows: Vec::new(),
        },
    }
}

async fn send_json(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request
        .timeout(USAGE_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("The provider usage service is unreachable ({error})."))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "The provider returned HTTP {status} for live usage."
        ));
    }
    response
        .json()
        .await
        .map_err(|_| "The provider usage payload could not be read.".to_owned())
}

fn parse_chatgpt(body: &Value) -> ParsedUsage {
    let Some(rate_limit) = body.get("rate_limit") else {
        return ParsedUsage::default();
    };
    let mut parsed = ParsedUsage::default();
    push_chatgpt_window(&mut parsed, rate_limit.get("primary_window"), None);
    push_chatgpt_window(&mut parsed, rate_limit.get("secondary_window"), None);
    if let Some(additional) = rate_limit
        .get("additional_windows")
        .and_then(Value::as_array)
    {
        for window in additional {
            let name = json_str(window, "name", "label");
            push_chatgpt_window(&mut parsed, Some(window), name);
        }
    }
    parsed
}

pub(crate) fn parse_chatgpt_reset_credits(body: &Value) -> Vec<AgentPoolUsageMetric> {
    let Some(count) = body
        .get("available_count")
        .and_then(Value::as_i64)
        .or_else(|| body.get("availableCount").and_then(Value::as_i64))
    else {
        return Vec::new();
    };
    let soonest = body
        .get("credits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|credit| json_str(credit, "status", "status") == Some("available"))
        .filter_map(|credit| parse_reset_at(credit.get("expires_at").or(credit.get("expiresAt"))))
        .min();
    vec![metric(
        "Reset credits",
        &format!("{count} available"),
        soonest.map(resets_in),
    )]
}

fn parse_claude(body: &Value) -> ParsedUsage {
    if body.pointer("/error/type").and_then(Value::as_str) == Some("rate_limit_error") {
        return ParsedUsage {
            metrics: vec![unavailable("Claude rate-limited the usage request.")],
            windows: Vec::new(),
        };
    }
    let mut parsed = ParsedUsage::default();
    push_percent_window(
        &mut parsed,
        "5-hour limit",
        body.get("five_hour").or_else(|| body.get("fiveHour")),
        "utilization",
        "used_percent",
        "resets_at",
        "resetsAt",
    );
    push_percent_window(
        &mut parsed,
        "Weekly limit",
        body.get("seven_day").or_else(|| body.get("sevenDay")),
        "utilization",
        "used_percent",
        "resets_at",
        "resetsAt",
    );
    if let Some(sonnet) = body
        .get("seven_day_sonnet")
        .or_else(|| body.get("sevenDaySonnet"))
    {
        push_percent_window(
            &mut parsed,
            "Sonnet weekly",
            Some(sonnet),
            "utilization",
            "used_percent",
            "resets_at",
            "resetsAt",
        );
    }
    if let Some(extra) = body.get("extra_usage").or_else(|| body.get("extraUsage")) {
        let used = json_f64(extra, "utilized", "used");
        let limit = json_f64(extra, "limit", "cap");
        if let (Some(used), Some(limit)) = (used, limit) {
            parsed.metrics.push(metric(
                "Extra credits",
                &format!("{used:.0} / {limit:.0} used"),
                parse_reset_at(extra.get("resets_at").or(extra.get("resetsAt"))).map(resets_in),
            ));
        }
    }
    parsed
}

fn parse_grok(body: &Value) -> ParsedUsage {
    let config = body.get("config").unwrap_or(body);
    let mut parsed = ParsedUsage::default();
    let used = json_f64(config, "creditUsagePercent", "credit_usage_percent");
    let period = config
        .get("currentPeriod")
        .or_else(|| config.get("current_period"));
    let period_type = period
        .and_then(|value| json_str(value, "type", "type"))
        .map(|value| value.trim_start_matches("USAGE_PERIOD_TYPE_").to_owned());
    let reset_at = period
        .and_then(|value| value.get("end"))
        .or_else(|| config.get("billingPeriodEnd"))
        .or_else(|| config.get("billing_period_end"))
        .and_then(|value| parse_reset_at(Some(value)));
    if let Some(used) = used {
        let (label, window_seconds) = match period_type.as_deref() {
            Some("WEEKLY") | Some("weekly") => ("Weekly limit", Some(WEEKLY_SECONDS)),
            Some("MONTHLY") | Some("monthly") => ("Monthly limit", None),
            _ => ("Usage limit", None),
        };
        parsed.metrics.push(metric(
            label,
            &remaining_percent(used),
            reset_at.map(resets_in),
        ));
        push_share_window(&mut parsed, label, used, reset_at, window_seconds);
    }
    if let Some(products) = config
        .get("productUsage")
        .or_else(|| config.get("product_usage"))
        .and_then(Value::as_array)
    {
        for product in products {
            let Some(name) = json_str(product, "product", "name") else {
                continue;
            };
            let Some(percent) = json_f64(product, "usagePercent", "usage_percent") else {
                continue;
            };
            parsed.metrics.push(metric(
                &format!("{name} usage"),
                &remaining_percent(percent),
                None,
            ));
        }
    }
    let prepaid = config
        .get("prepaidBalance")
        .or_else(|| config.get("prepaid_balance"))
        .and_then(json_money);
    if let Some(prepaid) = prepaid.filter(|value| *value > 0.0) {
        parsed
            .metrics
            .push(metric("Prepaid balance", &format!("${prepaid:.2}"), None));
    }
    parsed
}

fn push_chatgpt_window(parsed: &mut ParsedUsage, window: Option<&Value>, named: Option<&str>) {
    let Some(window) = window else {
        return;
    };
    if window.is_null() {
        return;
    }
    let Some(used) = json_f64(window, "used_percent", "usedPercent") else {
        return;
    };
    let seconds = json_f64(window, "limit_window_seconds", "limitWindowSeconds");
    let label = named
        .map(str::to_owned)
        .unwrap_or_else(|| window_label(seconds));
    let reset_at = parse_reset_at(window.get("reset_at").or(window.get("resetAt")));
    let tokens = token_detail(window);
    let detail = match (reset_at.map(resets_in), tokens) {
        (Some(reset), Some(tokens)) => Some(format!("{reset} · {tokens}")),
        (reset, tokens) => reset.or(tokens),
    };
    parsed
        .metrics
        .push(metric(&label, &remaining_percent(used), detail));
    push_share_window(
        parsed,
        &label,
        used,
        reset_at,
        seconds.map(|value| value.round() as i64),
    );
}

fn push_percent_window(
    parsed: &mut ParsedUsage,
    label: &str,
    window: Option<&Value>,
    utilization_camel: &str,
    used_snake: &str,
    resets_snake: &str,
    resets_camel: &str,
) {
    let Some(window) = window else {
        return;
    };
    if window.is_null() {
        return;
    }
    let Some(used) = json_f64(window, utilization_camel, used_snake) else {
        return;
    };
    let reset_at = parse_reset_at(window.get(resets_snake).or(window.get(resets_camel)));
    parsed.metrics.push(metric(
        label,
        &remaining_percent(used),
        reset_at.map(resets_in),
    ));
    let window_seconds = match label {
        "5-hour limit" => Some(FIVE_HOUR_SECONDS),
        "Weekly limit" | "Sonnet weekly" => Some(WEEKLY_SECONDS),
        _ => None,
    };
    push_share_window(parsed, label, used, reset_at, window_seconds);
}

fn push_share_window(
    parsed: &mut ParsedUsage,
    label: &str,
    used_percent: f64,
    reset_at: Option<DateTime<Utc>>,
    window_seconds: Option<i64>,
) {
    if !matches!(label, "5-hour limit" | "Weekly limit") {
        return;
    }
    parsed.windows.push(ShareWindow {
        label: label.to_owned(),
        reset_at,
        used_percent,
        window_seconds,
    });
}

fn window_label(seconds: Option<f64>) -> String {
    match seconds {
        Some(value) if value <= 21_600.0 => "5-hour limit".to_owned(),
        Some(value) if value <= 8.0 * 86_400.0 => "Weekly limit".to_owned(),
        Some(value) if value <= 40.0 * 86_400.0 => "Monthly limit".to_owned(),
        _ => "Usage limit".to_owned(),
    }
}

fn remaining_percent(used: f64) -> String {
    let remaining = (100.0 - used).clamp(0.0, 100.0);
    format!("{remaining:.0}% remaining")
}

fn token_detail(window: &Value) -> Option<String> {
    let used = json_f64(window, "used", "used_tokens")?;
    let limit = json_f64(window, "limit", "limit_tokens")?;
    Some(format!("{used:.0} / {limit:.0} tokens"))
}

fn resets_in(reset_at: DateTime<Utc>) -> String {
    let delta = reset_at - Utc::now();
    if delta.num_seconds() <= 0 {
        return "Resets now".to_owned();
    }
    let days = delta.num_days();
    let hours = delta.num_hours() % 24;
    let minutes = delta.num_minutes() % 60;
    if days > 0 {
        format!("Resets in {days}d {hours}h")
    } else if hours > 0 {
        format!("Resets in {hours}h {minutes}m")
    } else {
        format!("Resets in {minutes}m")
    }
}

fn parse_reset_at(value: Option<&Value>) -> Option<DateTime<Utc>> {
    let value = value?;
    if let Some(seconds) = value.as_f64() {
        return DateTime::from_timestamp(seconds as i64, 0);
    }
    if let Some(seconds) = value.as_i64() {
        return DateTime::from_timestamp(seconds, 0);
    }
    let raw = value.as_str()?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn json_f64(value: &Value, camel: &str, snake: &str) -> Option<f64> {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .and_then(|item| item.as_f64().or_else(|| item.as_i64().map(|n| n as f64)))
}

fn json_str<'a>(value: &'a Value, camel: &str, snake: &str) -> Option<&'a str> {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .and_then(Value::as_str)
}

fn json_money(value: &Value) -> Option<f64> {
    value
        .get("val")
        .or_else(|| value.get("value"))
        .and_then(|item| item.as_f64().or_else(|| item.as_i64().map(|n| n as f64)))
        .or_else(|| value.as_f64())
}

fn bearer_token(token: &Value) -> Option<&str> {
    token
        .get("access_token")
        .or_else(|| token.get("key"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn metric(label: &str, value: &str, detail: Option<String>) -> AgentPoolUsageMetric {
    AgentPoolUsageMetric {
        detail,
        label: label.to_owned(),
        value: value.to_owned(),
    }
}

fn unavailable(detail: &str) -> AgentPoolUsageMetric {
    metric("Usage", "Unavailable", Some(detail.to_owned()))
}

pub(crate) fn tokens_from_value(value: &Value) -> Option<TokenCounts> {
    let mut found = None;
    visit_usage(value, &mut found);
    found.filter(|counts| counts.units() > 0)
}

fn visit_usage(value: &Value, found: &mut Option<TokenCounts>) {
    match value {
        Value::Object(map) => {
            if let Some(usage) = map.get("usage")
                && let Some(counts) = counts_from_usage(usage)
            {
                *found = Some(counts);
            }
            for nested in map.values() {
                visit_usage(nested, found);
            }
        }
        Value::Array(items) => {
            for nested in items {
                visit_usage(nested, found);
            }
        }
        _ => {}
    }
}

fn counts_from_usage(usage: &Value) -> Option<TokenCounts> {
    let input = json_i64(usage, "input_tokens", "prompt_tokens").unwrap_or(0);
    let output = json_i64(usage, "output_tokens", "completion_tokens").unwrap_or(0);
    let cached = json_i64(usage, "cached_tokens", "cache_read_input_tokens")
        .or_else(|| {
            usage
                .pointer("/input_tokens_details/cached_tokens")
                .and_then(value_i64)
        })
        .or_else(|| {
            usage
                .pointer("/prompt_tokens_details/cached_tokens")
                .and_then(value_i64)
        })
        .unwrap_or(0);
    let cache_creation = json_i64(
        usage,
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
    )
    .unwrap_or(0);
    let reasoning = json_i64(usage, "reasoning_tokens", "reasoningTokens").unwrap_or(0);
    let counts = TokenCounts {
        cached_tokens: cached,
        input_tokens: input.saturating_add(cache_creation),
        output_tokens: output.saturating_add(reasoning),
    };
    (counts.units() > 0).then_some(counts)
}

fn json_i64(value: &Value, camel: &str, snake: &str) -> Option<i64> {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .and_then(value_i64)
}

fn value_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|n| i64::try_from(n).ok()))
        .or_else(|| value.as_f64().map(|n| n as i64))
}

#[cfg(test)]
mod tests {
    use super::{
        TokenCounts, UsageExtractor, parse_chatgpt, parse_chatgpt_reset_credits, parse_claude,
        parse_grok,
    };
    use serde_json::json;

    #[test]
    fn chatgpt_windows_are_labeled_by_duration_not_slot() {
        let metrics = parse_chatgpt(&json!({
            "rate_limit": {
                "primary_window": {
                    "used_percent": 25.0,
                    "limit_window_seconds": 604800,
                    "reset_at": 2_000_000_000
                },
                "secondary_window": null
            }
        }))
        .metrics;
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].label, "Weekly limit");
        assert_eq!(metrics[0].value, "75% remaining");
    }

    #[test]
    fn chatgpt_reports_five_hour_weekly_tokens_and_credits() {
        let metrics = parse_chatgpt(&json!({
            "rate_limit": {
                "primary_window": {
                    "used_percent": 68.0,
                    "limit_window_seconds": 18000,
                    "reset_at": 2_000_000_000,
                    "used": 34000,
                    "limit": 50000
                },
                "secondary_window": {
                    "used_percent": 10.0,
                    "limit_window_seconds": 604800,
                    "reset_at": 2_000_000_000
                }
            }
        }))
        .metrics;
        assert_eq!(metrics[0].label, "5-hour limit");
        assert_eq!(metrics[0].value, "32% remaining");
        assert!(
            metrics[0]
                .detail
                .as_deref()
                .unwrap_or_default()
                .contains("34000 / 50000 tokens")
        );
        assert_eq!(metrics[1].label, "Weekly limit");
        assert_eq!(metrics[1].value, "90% remaining");

        let credits = parse_chatgpt_reset_credits(&json!({
            "available_count": 2,
            "credits": [{ "status": "available", "expires_at": "2030-01-01T00:00:00Z" }]
        }));
        assert_eq!(credits[0].label, "Reset credits");
        assert_eq!(credits[0].value, "2 available");
    }

    #[test]
    fn claude_maps_five_hour_and_weekly_utilization() {
        let metrics = parse_claude(&json!({
            "five_hour": { "utilization": 40.0, "resets_at": "2030-01-01T00:00:00Z" },
            "seven_day": { "utilization": 12.0, "resets_at": "2030-01-08T00:00:00Z" },
            "seven_day_sonnet": { "utilization": 5.0, "resets_at": "2030-01-08T00:00:00Z" }
        }))
        .metrics;
        assert_eq!(metrics[0].label, "5-hour limit");
        assert_eq!(metrics[0].value, "60% remaining");
        assert_eq!(metrics[1].label, "Weekly limit");
        assert_eq!(metrics[1].value, "88% remaining");
        assert_eq!(metrics[2].label, "Sonnet weekly");
        assert_eq!(metrics[2].value, "95% remaining");
    }

    #[test]
    fn grok_reads_weekly_percent_and_product_breakdown() {
        let metrics = parse_grok(&json!({
            "config": {
                "creditUsagePercent": 55.0,
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "end": "2030-01-08T00:00:00Z"
                },
                "productUsage": [{ "product": "Build", "usagePercent": 55.0 }],
                "prepaidBalance": { "val": 12.5 }
            }
        }))
        .metrics;
        assert_eq!(metrics[0].label, "Weekly limit");
        assert_eq!(metrics[0].value, "45% remaining");
        assert_eq!(metrics[1].label, "Build usage");
        assert_eq!(metrics[2].label, "Prepaid balance");
        assert_eq!(metrics[2].value, "$12.50");
    }

    #[test]
    fn chatgpt_share_windows_keep_used_percent_and_duration() {
        let parsed = parse_chatgpt(&json!({
            "rate_limit": {
                "primary_window": {
                    "used_percent": 68.0,
                    "limit_window_seconds": 18000,
                    "reset_at": 2_000_000_000
                },
                "secondary_window": {
                    "used_percent": 10.0,
                    "limit_window_seconds": 604800,
                    "reset_at": 2_000_000_000
                }
            }
        }));
        assert_eq!(parsed.windows.len(), 2);
        assert_eq!(parsed.windows[0].label, "5-hour limit");
        assert_eq!(parsed.windows[0].used_percent, 68.0);
        assert_eq!(parsed.windows[0].window_seconds, Some(18_000));
        assert_eq!(parsed.windows[1].label, "Weekly limit");
    }

    #[test]
    fn extractor_reads_openai_responses_sse_and_claude_json() {
        let mut extractor = UsageExtractor::default();
        extractor.push(
            br#"data: {"type":"response.output_text.delta","delta":"hi"}
data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":4,"input_tokens_details":{"cached_tokens":3}}}}
data: [DONE]
"#,
        );
        assert_eq!(
            extractor.finish(),
            Some(TokenCounts {
                cached_tokens: 3,
                input_tokens: 12,
                output_tokens: 4,
            })
        );

        let mut extractor = UsageExtractor::default();
        extractor.push(
            br#"{"usage":{"input_tokens":8,"output_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":5,"reasoning_tokens":7}}"#,
        );
        assert_eq!(
            extractor.finish(),
            Some(TokenCounts {
                cached_tokens: 1,
                input_tokens: 13,
                output_tokens: 9,
            })
        );
    }
}
