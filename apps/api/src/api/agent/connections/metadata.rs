//! Account identity and plan details read from provider tokens and profiles.

use std::str::FromStr;

use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;

use super::token::{decrypt_json, token_claim, token_claims};
use crate::{core::AppState, utils::provider_catalogue::AgentProvider};

#[derive(Debug, FromRow)]
struct ConnectionMetadataCredentialRow {
    connection_id: Uuid,
    credential_ciphertext: Vec<u8>,
    credential_nonce: Vec<u8>,
    plan: Option<String>,
    provider: String,
}

pub(super) fn reauthorization_identity_matches(stored: Option<&str>, new: Option<&str>) -> bool {
    matches!((stored, new), (Some(stored), Some(new)) if stored == new)
}

pub(super) fn provider_account_identity(
    provider: AgentProvider,
    token: &Value,
    provider_profile: Option<&Value>,
) -> Option<String> {
    // ChatGPT account IDs identify a workspace/subscription context, which can
    // be shared by distinct logins. Recompute personal identity before reading
    // legacy cached `id:<workspace>` values so reconnect cannot merge users.
    if provider == AgentProvider::Chatgpt {
        let claims = token_claims(token);
        if let Some(subject) = claims
            .as_ref()
            .and_then(|claims| claims.get("sub"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Some(format!("chatgpt:sub:{subject}"));
        }
        return token
            .pointer("/account/email_address")
            .or_else(|| token.pointer("/account/email"))
            .or_else(|| token.get("email"))
            .and_then(Value::as_str)
            .or_else(|| claims.as_ref()?.get("email")?.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|email| format!("chatgpt:email:{}", email.to_ascii_lowercase()));
    }
    if let Some(identity) = token
        .get("hub_account_identity")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return Some(identity.to_owned());
    }
    let claims = token_claims(token);
    let provider_id = token
        .pointer("/account/id")
        .and_then(Value::as_str)
        .or_else(|| token.pointer("/account/uuid").and_then(Value::as_str))
        .or_else(|| {
            let profile = provider_profile?;
            profile
                .pointer("/account/id")
                .or_else(|| profile.pointer("/account/uuid"))
                .or_else(|| profile.pointer("/user/id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            claims
                .as_ref()
                .and_then(|value| value.get("sub"))
                .and_then(Value::as_str)
        })
        .filter(|value| !value.is_empty());
    if let Some(provider_id) = provider_id {
        return Some(format!("id:{provider_id}"));
    }

    if matches!(provider, AgentProvider::Deepseek | AgentProvider::Groq) {
        let access_token = token.get("access_token").and_then(Value::as_str)?;
        let digest = Sha256::digest(access_token.as_bytes());
        return Some(format!("key:{digest:x}"));
    }

    token
        .pointer("/account/email_address")
        .or_else(|| token.pointer("/account/email"))
        .or_else(|| token.get("email"))
        .and_then(Value::as_str)
        .or_else(|| {
            let profile = provider_profile?;
            profile
                .pointer("/account/email_address")
                .or_else(|| profile.pointer("/account/email"))
                .or_else(|| profile.pointer("/user/email"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            claims
                .as_ref()
                .and_then(|value| value.get("email"))
                .and_then(Value::as_str)
        })
        .map(|email| format!("email:{}", email.trim().to_ascii_lowercase()))
}

pub(super) fn connection_metadata(
    provider: AgentProvider,
    token: &Value,
    provider_profile: Option<&Value>,
) -> (Option<String>, Option<String>) {
    let claims = token_claims(token);
    let account_label = token
        .get("api_key_last_four")
        .and_then(Value::as_str)
        .filter(|value| value.len() == 4 && value.is_ascii())
        .map(|value| format!("••••{value}"))
        .or_else(|| {
            token
                .pointer("/account/email_address")
                .or_else(|| token.pointer("/account/email"))
                .or_else(|| token.get("email"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    claims
                        .as_ref()
                        .and_then(|value| value.get("email"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .as_deref()
                .map(mask_account_label)
        });
    let token_plan = || {
        token
            .get("subscription_type")
            .or_else(|| token.get("rate_limit_tier"))
            .or_else(|| token.get("plan"))
            .and_then(Value::as_str)
    };
    let plan = match provider {
        AgentProvider::Chatgpt => token_plan()
            .or_else(|| {
                claims.as_ref().and_then(|value| {
                    value
                        .get("https://api.openai.com/auth.chatgpt_plan_type")
                        .or_else(|| {
                            value
                                .get("https://api.openai.com/auth")
                                .and_then(|auth| auth.get("chatgpt_plan_type"))
                        })
                        .or_else(|| value.get("plan"))
                        .and_then(Value::as_str)
                })
            })
            .map(normalize_plan_label),
        AgentProvider::Claude => provider_profile
            .and_then(claude_plan_from_profile)
            .or_else(|| token_plan().map(normalize_plan_label)),
        AgentProvider::Gemini | AgentProvider::Deepseek | AgentProvider::Groq => {
            token_plan().map(normalize_plan_label)
        }
        AgentProvider::Grok => token_plan().and_then(grok_plan_label).or_else(|| {
            token_claim(token, "tier")
                .as_ref()
                .and_then(grok_tier_label)
        }),
    };

    (account_label, plan)
}

pub(super) async fn resolved_connection_metadata(
    state: &AppState,
    provider: AgentProvider,
    token: &Value,
) -> (Option<String>, Option<String>) {
    let profile = if provider == AgentProvider::Claude {
        fetch_claude_profile(state, token).await
    } else {
        None
    };
    connection_metadata(provider, token, profile.as_ref())
}

pub(super) async fn fetch_claude_profile(state: &AppState, token: &Value) -> Option<Value> {
    let access_token = token.get("access_token").and_then(Value::as_str)?;
    let response = match state
        .http
        .get(&state.config.claude_profile_url)
        .bearer_auth(access_token)
        .header("accept", "application/json")
        .header("cache-control", "no-cache")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            eprintln!("Claude profile request failed: {error}");
            return None;
        }
    };
    let status = response.status();
    if !status.is_success() {
        eprintln!("Claude profile returned HTTP {status}");
        return None;
    }
    match response.json::<Value>().await {
        Ok(profile) => Some(profile),
        Err(_) => {
            eprintln!("Claude profile returned an unexpected response");
            None
        }
    }
}

fn claude_plan_from_profile(profile: &Value) -> Option<String> {
    match profile
        .pointer("/organization/organization_type")
        .and_then(Value::as_str)?
    {
        "claude_max" => Some("MAX".to_owned()),
        "claude_pro" => Some("Pro".to_owned()),
        "claude_team" => Some("Team".to_owned()),
        "claude_enterprise" => Some("Enterprise".to_owned()),
        _ => None,
    }
}

fn grok_plan_label(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().replace(' ', "_").as_str() {
        "grokpro" | "supergrok" => Some("Grok".to_owned()),
        "supergrokpro" | "supergrok_heavy" => Some("Heavy".to_owned()),
        "supergroklite" | "supergrok_lite" => Some("Lite".to_owned()),
        "supergrokplus" | "supergrok_plus" => Some("Plus".to_owned()),
        "xbasic" | "x_basic" => Some("X Basic".to_owned()),
        "xpremium" | "x_premium" => Some("X Premium".to_owned()),
        "xpremiumplus" | "x_premium_plus" => Some("X Premium+".to_owned()),
        "free" => Some("Free".to_owned()),
        _ => None,
    }
}

fn grok_tier_label(value: &Value) -> Option<String> {
    if let Some(value) = value.as_str() {
        return grok_plan_label(value);
    }
    match value.as_u64()? {
        0 => Some("Free".to_owned()),
        1 => Some("Grok".to_owned()),
        2 => Some("X Basic".to_owned()),
        3 => Some("X Premium".to_owned()),
        4 => Some("X Premium+".to_owned()),
        5 => Some("Heavy".to_owned()),
        6 => Some("Lite".to_owned()),
        7 => Some("Plus".to_owned()),
        _ => None,
    }
}

pub async fn refresh_stored_connection_metadata(state: &AppState) -> Result<u64, sqlx::Error> {
    let rows = sqlx::query_as::<_, ConnectionMetadataCredentialRow>(
        "SELECT connections.id AS connection_id, credentials.credential_ciphertext,
                credentials.credential_nonce, connections.plan, connections.provider
         FROM agent_connections AS connections
         JOIN agent_connection_credentials AS credentials
           ON credentials.connection_id = connections.id
         WHERE connections.status = 'connected'",
    )
    .fetch_all(&state.pool)
    .await?;

    let mut updated = 0;
    for row in rows {
        let Ok(token) = decrypt_json::<Value>(
            &state.config.credential_encryption_key,
            &row.credential_ciphertext,
            &row.credential_nonce,
        ) else {
            continue;
        };
        let Ok(provider) = AgentProvider::from_str(&row.provider) else {
            continue;
        };
        let (account_label, detected_plan) =
            if provider == AgentProvider::Claude && row.plan.is_some() {
                connection_metadata(provider, &token, None)
            } else {
                resolved_connection_metadata(state, provider, &token).await
            };
        let plan = detected_plan.or(row.plan);
        updated += sqlx::query(
            "UPDATE agent_connections SET account_label = COALESCE($2, account_label),
                 plan = COALESCE($3, plan), updated_at = NOW()
             WHERE id = $1
               AND (account_label IS DISTINCT FROM COALESCE($2, account_label)
                    OR plan IS DISTINCT FROM COALESCE($3, plan))",
        )
        .bind(row.connection_id)
        .bind(account_label)
        .bind(plan)
        .execute(&state.pool)
        .await?
        .rows_affected();
    }

    Ok(updated)
}

fn normalize_plan_label(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "k12" => "K12".to_owned(),
        "max" => "Max".to_owned(),
        "plus" => "Plus".to_owned(),
        _ => value.trim().to_owned(),
    }
}

pub(super) fn mask_account_label(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return "connected account".to_owned();
    };
    let local = local.split_once('+').map_or(local, |(base, _)| base);
    let Some((domain_without_suffix, suffix)) = domain.rsplit_once('.') else {
        return "connected account".to_owned();
    };
    let domain_prefix = domain_without_suffix
        .split('.')
        .next()
        .unwrap_or_default()
        .chars()
        .take(3)
        .collect::<String>();
    let local_chars = local.chars().collect::<Vec<_>>();
    if local_chars.is_empty() || domain_prefix.is_empty() || suffix.is_empty() {
        return "connected account".to_owned();
    }
    let local_prefix_len = local_chars.len().min(2);
    let local_prefix = local_chars
        .iter()
        .take(local_prefix_len)
        .collect::<String>();
    let suffix_start = local_chars.len().saturating_sub(3).max(local_prefix_len);
    let local_suffix = local_chars.iter().skip(suffix_start).collect::<String>();
    format!("{local_prefix}**{local_suffix}@{domain_prefix}**.{suffix}")
}
