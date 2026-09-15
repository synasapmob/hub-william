use chrono::{DateTime, Duration, Utc};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{AgentProvider, AppState, usage::ShareWindow};

#[derive(Clone, Debug)]
pub struct UsageEvent {
    pub cached_tokens: i64,
    pub created_at: DateTime<Utc>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub user_id: Uuid,
}

#[derive(Clone, Copy, Debug, Default)]
struct TokenTotals {
    cached_tokens: i64,
    input_tokens: i64,
    output_tokens: i64,
}

impl TokenTotals {
    fn add(&mut self, event: &UsageEvent) {
        self.cached_tokens = self.cached_tokens.saturating_add(event.cached_tokens);
        self.input_tokens = self.input_tokens.saturating_add(event.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(event.output_tokens);
    }

    fn units(self) -> i64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cached_tokens)
    }
}

#[derive(Clone, Debug)]
pub struct ShareEvidence {
    pub available_percent: i32,
    pub budget_units: Option<i64>,
    pub cap_units: Option<i64>,
    pub fail_open_reason: Option<&'static str>,
    pub member_count: i32,
    pub pool_cached_tokens: i64,
    pub pool_input_tokens: i64,
    pub pool_output_tokens: i64,
    pub pool_units: i64,
    pub provider_used_percent: Option<f64>,
    pub remaining_units: Option<i64>,
    pub user_cached_tokens: i64,
    pub user_input_tokens: i64,
    pub user_output_tokens: i64,
    pub user_units: i64,
    pub window_label: Option<String>,
}

impl ShareEvidence {
    pub fn fail_open(member_count: usize, reason: &'static str) -> Self {
        Self {
            available_percent: 100,
            budget_units: None,
            cap_units: None,
            fail_open_reason: Some(reason),
            member_count: i32::try_from(member_count).unwrap_or(0),
            pool_cached_tokens: 0,
            pool_input_tokens: 0,
            pool_output_tokens: 0,
            pool_units: 0,
            provider_used_percent: None,
            remaining_units: None,
            user_cached_tokens: 0,
            user_input_tokens: 0,
            user_output_tokens: 0,
            user_units: 0,
            window_label: None,
        }
    }
}

#[derive(FromRow)]
struct UsageEventRow {
    cached_tokens: i64,
    created_at: DateTime<Utc>,
    input_tokens: i64,
    output_tokens: i64,
    user_id: Uuid,
}

pub async fn load_events(
    pool: &sqlx::PgPool,
    connection_id: Uuid,
) -> Result<Vec<UsageEvent>, sqlx::Error> {
    let rows = sqlx::query_as::<_, UsageEventRow>(
        "SELECT user_id, input_tokens, output_tokens, cached_tokens, created_at
         FROM agent_pool_usage_events
         WHERE connection_id = $1
           AND created_at >= NOW() - INTERVAL '8 days'",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| UsageEvent {
            cached_tokens: row.cached_tokens,
            created_at: row.created_at,
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            user_id: row.user_id,
        })
        .collect())
}

pub fn member_available_percent(
    windows: &[ShareWindow],
    events: &[UsageEvent],
    user_id: Uuid,
    member_count: usize,
    now: DateTime<Utc>,
) -> i32 {
    member_share_evidence(windows, events, user_id, member_count, now).available_percent
}

pub fn member_share_evidence(
    windows: &[ShareWindow],
    events: &[UsageEvent],
    user_id: Uuid,
    member_count: usize,
    now: DateTime<Utc>,
) -> ShareEvidence {
    let mut best: Option<ShareEvidence> = None;
    for window in windows
        .iter()
        .filter(|window| is_share_window(&window.label))
    {
        let Some(evidence) = window_evidence(window, events, user_id, member_count, now) else {
            continue;
        };
        let replace = match &best {
            None => true,
            Some(current) if evidence.available_percent < current.available_percent => true,
            Some(current)
                if evidence.available_percent == current.available_percent
                    && current.fail_open_reason.is_some()
                    && evidence.fail_open_reason.is_none() =>
            {
                true
            }
            _ => false,
        };
        if replace {
            best = Some(evidence);
        }
    }
    best.unwrap_or_else(|| {
        ShareEvidence::fail_open(
            member_count,
            "No live 5-hour or weekly window was reported.",
        )
    })
}

pub fn request_allowed(
    windows: &[ShareWindow],
    events: &[UsageEvent],
    user_id: Uuid,
    member_count: usize,
    now: DateTime<Utc>,
) -> bool {
    member_available_percent(windows, events, user_id, member_count, now) > 0
}

pub async fn allow_gateway_request(
    state: &AppState,
    connection_id: Uuid,
    user_id: Uuid,
    provider: AgentProvider,
) -> bool {
    let events = match load_events(&state.pool, connection_id).await {
        Ok(events) => events,
        Err(error) => {
            eprintln!("pool share event load failed: {error}");
            return true;
        }
    };
    if events.is_empty() {
        return true;
    }
    let member_count = match member_count(&state.pool, connection_id).await {
        Ok(count) if count > 0 => count,
        Ok(_) => return true,
        Err(error) => {
            eprintln!("pool share member count failed: {error}");
            return true;
        }
    };
    let usage = crate::usage::for_connection(state, connection_id, provider).await;
    request_allowed(&usage.windows, &events, user_id, member_count, Utc::now())
}

async fn member_count(pool: &sqlx::PgPool, connection_id: Uuid) -> Result<usize, sqlx::Error> {
    let accepted = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agent_pool_join_requests
         WHERE connection_id = $1 AND status = 'accepted'",
    )
    .bind(connection_id)
    .fetch_one(pool)
    .await?;
    Ok(usize::try_from(accepted.saturating_add(1)).unwrap_or(1))
}

pub(crate) fn available_percent(
    used_percent: f64,
    pool_units: i64,
    user_units: i64,
    member_count: usize,
) -> i32 {
    if member_count == 0 || !used_percent.is_finite() || used_percent <= 0.0 || pool_units <= 0 {
        return 100;
    }
    let budget = pool_units as f64 / (used_percent / 100.0);
    let cap = budget / member_count as f64;
    if !cap.is_finite() || cap <= 0.0 {
        return 100;
    }
    (((cap - user_units as f64) / cap) * 100.0)
        .clamp(0.0, 100.0)
        .round() as i32
}

pub(crate) fn window_range(
    reset_at: Option<DateTime<Utc>>,
    window_seconds: Option<i64>,
    now: DateTime<Utc>,
) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let seconds = window_seconds.filter(|value| *value > 0)?;
    let duration = Duration::seconds(seconds);
    match reset_at {
        Some(reset) if reset > now => Some((reset - duration, reset)),
        _ => Some((now - duration, now)),
    }
}

fn is_share_window(label: &str) -> bool {
    matches!(label, "5-hour limit" | "Weekly limit")
}

fn window_evidence(
    window: &ShareWindow,
    events: &[UsageEvent],
    user_id: Uuid,
    member_count: usize,
    now: DateTime<Utc>,
) -> Option<ShareEvidence> {
    let range = window_range(window.reset_at, window.window_seconds, now)?;
    let user = totals_in(events, Some(user_id), range);
    let pool = totals_in(events, None, range);
    let member_count_i32 = i32::try_from(member_count).unwrap_or(0);
    let mut evidence = ShareEvidence {
        available_percent: 100,
        budget_units: None,
        cap_units: None,
        fail_open_reason: None,
        member_count: member_count_i32,
        pool_cached_tokens: pool.cached_tokens,
        pool_input_tokens: pool.input_tokens,
        pool_output_tokens: pool.output_tokens,
        pool_units: pool.units(),
        provider_used_percent: Some(window.used_percent),
        remaining_units: None,
        user_cached_tokens: user.cached_tokens,
        user_input_tokens: user.input_tokens,
        user_output_tokens: user.output_tokens,
        user_units: user.units(),
        window_label: Some(window.label.clone()),
    };
    if member_count == 0 {
        evidence.fail_open_reason = Some("The pool has no members to split.");
        return Some(evidence);
    }
    if !window.used_percent.is_finite() || window.used_percent <= 0.0 {
        evidence.fail_open_reason =
            Some("The provider reported 0% used, so Hub cannot estimate the window budget.");
        return Some(evidence);
    }
    if pool.units() <= 0 {
        evidence.fail_open_reason = Some("Hub has not recorded gateway tokens in this window.");
        return Some(evidence);
    }
    let budget = pool.units() as f64 / (window.used_percent / 100.0);
    let cap = budget / member_count as f64;
    if !cap.is_finite() || cap <= 0.0 {
        evidence.fail_open_reason = Some("The equal-share cap could not be estimated.");
        return Some(evidence);
    }
    let remaining = (cap - user.units() as f64).clamp(0.0, cap);
    evidence.available_percent = available_percent(
        window.used_percent,
        pool.units(),
        user.units(),
        member_count,
    );
    evidence.budget_units = Some(budget.round() as i64);
    evidence.cap_units = Some(cap.round() as i64);
    evidence.remaining_units = Some(remaining.round() as i64);
    Some(evidence)
}

fn totals_in(
    events: &[UsageEvent],
    user_id: Option<Uuid>,
    range: (DateTime<Utc>, DateTime<Utc>),
) -> TokenTotals {
    let mut totals = TokenTotals::default();
    for event in events {
        if event.created_at >= range.0
            && event.created_at < range.1
            && user_id.is_none_or(|id| event.user_id == id)
        {
            totals.add(event);
        }
    }
    totals
}

#[cfg(test)]
mod tests {
    use super::{
        UsageEvent, available_percent, member_available_percent, member_share_evidence,
        request_allowed, window_range,
    };
    use crate::usage::ShareWindow;
    use chrono::{Duration, TimeZone, Utc};
    use uuid::Uuid;

    fn event(user_id: Uuid, units: i64, created_at: chrono::DateTime<Utc>) -> UsageEvent {
        UsageEvent {
            cached_tokens: 0,
            created_at,
            input_tokens: units,
            output_tokens: 0,
            user_id,
        }
    }

    #[test]
    fn fail_open_when_provider_used_percent_is_zero() {
        assert_eq!(available_percent(0.0, 80, 80, 2), 100);
    }

    #[test]
    fn fail_open_when_the_pool_has_no_recorded_units() {
        assert_eq!(available_percent(40.0, 0, 0, 2), 100);
    }

    #[test]
    fn owner_only_matches_provider_remaining() {
        assert_eq!(available_percent(25.0, 100, 100, 1), 75);
    }

    #[test]
    fn two_members_split_an_observed_full_window_evenly() {
        assert_eq!(available_percent(100.0, 200, 200, 2), 0);
        assert_eq!(available_percent(100.0, 200, 0, 2), 100);
        assert_eq!(available_percent(50.0, 100, 80, 2), 20);
        assert_eq!(available_percent(50.0, 100, 20, 2), 80);
    }

    #[test]
    fn display_uses_the_tighter_of_five_hour_and_weekly() {
        let now = Utc.with_ymd_and_hms(2026, 9, 12, 12, 0, 0).unwrap();
        let owner = Uuid::from_u128(1);
        let member = Uuid::from_u128(2);
        let windows = [
            ShareWindow {
                label: "5-hour limit".to_owned(),
                reset_at: Some(now + Duration::hours(2)),
                used_percent: 50.0,
                window_seconds: Some(18_000),
            },
            ShareWindow {
                label: "Weekly limit".to_owned(),
                reset_at: Some(now + Duration::days(3)),
                used_percent: 20.0,
                window_seconds: Some(604_800),
            },
        ];
        let events = [
            event(owner, 80, now - Duration::hours(1)),
            event(member, 20, now - Duration::hours(1)),
            event(owner, 20, now - Duration::days(2)),
        ];
        assert_eq!(
            member_available_percent(&windows, &events, owner, 2, now),
            20
        );
        assert_eq!(
            member_available_percent(&windows, &events, member, 2, now),
            80
        );
        let owner_share = member_share_evidence(&windows, &events, owner, 2, now);
        assert_eq!(owner_share.window_label.as_deref(), Some("5-hour limit"));
        assert_eq!(owner_share.provider_used_percent, Some(50.0));
        assert_eq!(owner_share.pool_units, 100);
        assert_eq!(owner_share.user_units, 80);
        assert_eq!(owner_share.budget_units, Some(200));
        assert_eq!(owner_share.cap_units, Some(100));
        assert_eq!(owner_share.remaining_units, Some(20));
        assert_eq!(owner_share.fail_open_reason, None);
    }

    #[test]
    fn unknown_window_labels_do_not_affect_share() {
        let now = Utc.with_ymd_and_hms(2026, 9, 12, 12, 0, 0).unwrap();
        let windows = [ShareWindow {
            label: "Reset credits".to_owned(),
            reset_at: Some(now + Duration::hours(1)),
            used_percent: 90.0,
            window_seconds: Some(18_000),
        }];
        assert_eq!(
            member_available_percent(&windows, &[], Uuid::from_u128(1), 2, now),
            100
        );
    }

    #[test]
    fn current_window_uses_reset_at_when_it_is_still_in_the_future() {
        let now = Utc.with_ymd_and_hms(2026, 9, 12, 12, 0, 0).unwrap();
        let reset = now + Duration::hours(1);
        let range = window_range(Some(reset), Some(18_000), now).expect("range");
        assert_eq!(range.1, reset);
        assert_eq!(range.0, reset - Duration::seconds(18_000));
    }

    #[test]
    fn gateway_blocks_only_when_remaining_share_is_zero() {
        let now = Utc.with_ymd_and_hms(2026, 9, 12, 12, 0, 0).unwrap();
        let owner = Uuid::from_u128(1);
        let member = Uuid::from_u128(2);
        let windows = [ShareWindow {
            label: "Weekly limit".to_owned(),
            reset_at: Some(now + Duration::days(3)),
            used_percent: 100.0,
            window_seconds: Some(604_800),
        }];
        let events = [
            event(owner, 200, now - Duration::hours(1)),
            event(member, 0, now - Duration::hours(1)),
        ];
        assert!(!request_allowed(&windows, &events, owner, 2, now));
        assert!(request_allowed(&windows, &events, member, 2, now));
        assert!(request_allowed(&windows, &[], owner, 2, now));
    }

    #[test]
    fn elapsed_reset_falls_back_to_a_trailing_window() {
        let now = Utc.with_ymd_and_hms(2026, 9, 12, 12, 0, 0).unwrap();
        let range =
            window_range(Some(now - Duration::minutes(1)), Some(3_600), now).expect("range");
        assert_eq!(range.1, now);
        assert_eq!(range.0, now - Duration::seconds(3_600));
    }
}
