use chrono::{DateTime, Utc};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    AgentPoolUsageMetric, AgentProvider, AppState, connections::provider_credential,
    gateway::chatgpt_account_id,
};

const USAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

pub async fn for_connection(
    state: &AppState,
    connection_id: Uuid,
    provider: AgentProvider,
) -> Vec<AgentPoolUsageMetric> {
    match tokio::time::timeout(
        USAGE_TIMEOUT,
        fetch_provider_usage(state, connection_id, provider),
    )
    .await
    {
        Ok(metrics) if !metrics.is_empty() => metrics,
        Ok(_) => Vec::new(),
        Err(_) => vec![unavailable("The provider usage request timed out.")],
    }
}

async fn fetch_provider_usage(
    state: &AppState,
    connection_id: Uuid,
    provider: AgentProvider,
) -> Vec<AgentPoolUsageMetric> {
    let token = match provider_credential(state, connection_id).await {
        Ok((_, token)) => token,
        Err(error) => {
            eprintln!("{provider} usage credential refresh failed: {error:?}");
            return vec![unavailable("Could not refresh the provider session.")];
        }
    };
    let Some(access_token) = bearer_token(&token) else {
        return vec![unavailable("The connected account has no access token.")];
    };

    match provider {
        AgentProvider::Chatgpt => chatgpt_usage(state, &token, access_token).await,
        AgentProvider::Claude => claude_usage(state, access_token).await,
        AgentProvider::Grok => grok_usage(state, access_token).await,
    }
}

async fn chatgpt_usage(
    state: &AppState,
    token: &Value,
    access_token: &str,
) -> Vec<AgentPoolUsageMetric> {
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
        Err(detail) => return vec![unavailable(&detail)],
    };
    let mut metrics = parse_chatgpt_usage(&usage);

    let mut credits_request = state
        .http
        .get("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits")
        .bearer_auth(access_token)
        .header("user-agent", "codex_cli_rs/0.153.4");
    if let Some(account_id) = chatgpt_account_id(token) {
        credits_request = credits_request.header("chatgpt-account-id", account_id);
    }
    if let Ok(credits) = send_json(credits_request).await {
        metrics.extend(parse_chatgpt_reset_credits(&credits));
    }
    metrics
}

async fn claude_usage(state: &AppState, access_token: &str) -> Vec<AgentPoolUsageMetric> {
    let request = state
        .http
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("user-agent", "claude-code/2.1.121")
        .header("accept", "application/json");
    match send_json(request).await {
        Ok(body) => parse_claude_usage(&body),
        Err(detail) => vec![unavailable(&detail)],
    }
}

async fn grok_usage(state: &AppState, access_token: &str) -> Vec<AgentPoolUsageMetric> {
    let request = state
        .http
        .get("https://cli-chat-proxy.grok.com/v1/billing?format=credits")
        .bearer_auth(access_token)
        .header("x-xai-token-auth", "xai-grok-cli")
        .header("x-grok-client-version", "1.0.13")
        .header("x-grok-client-identifier", "grok-shell")
        .header("user-agent", "xai-grok-build/1.0.13");
    match send_json(request).await {
        Ok(body) => parse_grok_usage(&body),
        Err(detail) => vec![unavailable(&detail)],
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

pub(crate) fn parse_chatgpt_usage(body: &Value) -> Vec<AgentPoolUsageMetric> {
    let Some(rate_limit) = body.get("rate_limit") else {
        return Vec::new();
    };
    let mut metrics = Vec::new();
    push_chatgpt_window(&mut metrics, rate_limit.get("primary_window"), None);
    push_chatgpt_window(&mut metrics, rate_limit.get("secondary_window"), None);
    if let Some(additional) = rate_limit
        .get("additional_windows")
        .and_then(Value::as_array)
    {
        for window in additional {
            let name = json_str(window, "name", "label");
            push_chatgpt_window(&mut metrics, Some(window), name);
        }
    }
    metrics
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

pub(crate) fn parse_claude_usage(body: &Value) -> Vec<AgentPoolUsageMetric> {
    if body.pointer("/error/type").and_then(Value::as_str) == Some("rate_limit_error") {
        return vec![unavailable("Claude rate-limited the usage request.")];
    }
    let mut metrics = Vec::new();
    push_percent_window(
        &mut metrics,
        "5-hour limit",
        body.get("five_hour").or_else(|| body.get("fiveHour")),
        "utilization",
        "used_percent",
        "resets_at",
        "resetsAt",
    );
    push_percent_window(
        &mut metrics,
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
            &mut metrics,
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
            metrics.push(metric(
                "Extra credits",
                &format!("{used:.0} / {limit:.0} used"),
                parse_reset_at(extra.get("resets_at").or(extra.get("resetsAt"))).map(resets_in),
            ));
        }
    }
    metrics
}

pub(crate) fn parse_grok_usage(body: &Value) -> Vec<AgentPoolUsageMetric> {
    let config = body.get("config").unwrap_or(body);
    let mut metrics = Vec::new();
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
        let label = match period_type.as_deref() {
            Some("WEEKLY") | Some("weekly") => "Weekly limit",
            Some("MONTHLY") | Some("monthly") => "Monthly limit",
            _ => "Usage limit",
        };
        metrics.push(metric(
            label,
            &remaining_percent(used),
            reset_at.map(resets_in),
        ));
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
            metrics.push(metric(
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
        metrics.push(metric("Prepaid balance", &format!("${prepaid:.2}"), None));
    }
    metrics
}

fn push_chatgpt_window(
    metrics: &mut Vec<AgentPoolUsageMetric>,
    window: Option<&Value>,
    named: Option<&str>,
) {
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
    let reset = parse_reset_at(window.get("reset_at").or(window.get("resetAt"))).map(resets_in);
    let tokens = token_detail(window);
    let detail = match (reset, tokens) {
        (Some(reset), Some(tokens)) => Some(format!("{reset} · {tokens}")),
        (reset, tokens) => reset.or(tokens),
    };
    metrics.push(metric(&label, &remaining_percent(used), detail));
}

fn push_percent_window(
    metrics: &mut Vec<AgentPoolUsageMetric>,
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
    metrics.push(metric(
        label,
        &remaining_percent(used),
        parse_reset_at(window.get(resets_snake).or(window.get(resets_camel))).map(resets_in),
    ));
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

#[cfg(test)]
mod tests {
    use super::{
        parse_chatgpt_reset_credits, parse_chatgpt_usage, parse_claude_usage, parse_grok_usage,
    };
    use serde_json::json;

    #[test]
    fn chatgpt_windows_are_labeled_by_duration_not_slot() {
        let metrics = parse_chatgpt_usage(&json!({
            "rate_limit": {
                "primary_window": {
                    "used_percent": 25.0,
                    "limit_window_seconds": 604800,
                    "reset_at": 2_000_000_000
                },
                "secondary_window": null
            }
        }));
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].label, "Weekly limit");
        assert_eq!(metrics[0].value, "75% remaining");
    }

    #[test]
    fn chatgpt_reports_five_hour_weekly_tokens_and_credits() {
        let metrics = parse_chatgpt_usage(&json!({
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
        }));
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
        let metrics = parse_claude_usage(&json!({
            "five_hour": { "utilization": 40.0, "resets_at": "2030-01-01T00:00:00Z" },
            "seven_day": { "utilization": 12.0, "resets_at": "2030-01-08T00:00:00Z" },
            "seven_day_sonnet": { "utilization": 5.0, "resets_at": "2030-01-08T00:00:00Z" }
        }));
        assert_eq!(metrics[0].label, "5-hour limit");
        assert_eq!(metrics[0].value, "60% remaining");
        assert_eq!(metrics[1].label, "Weekly limit");
        assert_eq!(metrics[1].value, "88% remaining");
        assert_eq!(metrics[2].label, "Sonnet weekly");
        assert_eq!(metrics[2].value, "95% remaining");
    }

    #[test]
    fn grok_reads_weekly_percent_and_product_breakdown() {
        let metrics = parse_grok_usage(&json!({
            "config": {
                "creditUsagePercent": 55.0,
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "end": "2030-01-08T00:00:00Z"
                },
                "productUsage": [{ "product": "Build", "usagePercent": 55.0 }],
                "prepaidBalance": { "val": 12.5 }
            }
        }));
        assert_eq!(metrics[0].label, "Weekly limit");
        assert_eq!(metrics[0].value, "45% remaining");
        assert_eq!(metrics[1].label, "Build usage");
        assert_eq!(metrics[2].label, "Prepaid balance");
        assert_eq!(metrics[2].value, "$12.50");
    }
}
