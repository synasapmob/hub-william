use chrono::{DateTime, Duration, Utc};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{AgentProvider, AppState, usage::ShareWindow};

#[derive(Clone, Debug)]
pub struct UsageEvent {
    pub created_at: DateTime<Utc>,
    pub units: i64,
    pub user_id: Uuid,
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
            created_at: row.created_at,
            units: row
                .input_tokens
                .saturating_add(row.output_tokens)
                .saturating_add(row.cached_tokens),
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
    let percents = windows
        .iter()
        .filter(|window| is_share_window(&window.label))
        .filter_map(|window| {
            let range = window_range(window.reset_at, window.window_seconds, now)?;
            Some(available_percent(
                window.used_percent,
                units_in(events, None, range),
                units_in(events, Some(user_id), range),
                member_count,
            ))
        })
        .collect::<Vec<_>>();
    percents.into_iter().min().unwrap_or(100)
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

fn units_in(
    events: &[UsageEvent],
    user_id: Option<Uuid>,
    range: (DateTime<Utc>, DateTime<Utc>),
) -> i64 {
    events
        .iter()
        .filter(|event| {
            event.created_at >= range.0
                && event.created_at < range.1
                && user_id.is_none_or(|id| event.user_id == id)
        })
        .map(|event| event.units)
        .fold(0_i64, i64::saturating_add)
}

#[cfg(test)]
mod tests {
    use super::{
        UsageEvent, available_percent, member_available_percent, request_allowed, window_range,
    };
    use crate::usage::ShareWindow;
    use chrono::{Duration, TimeZone, Utc};
    use uuid::Uuid;

    fn event(user_id: Uuid, units: i64, created_at: chrono::DateTime<Utc>) -> UsageEvent {
        UsageEvent {
            created_at,
            units,
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
