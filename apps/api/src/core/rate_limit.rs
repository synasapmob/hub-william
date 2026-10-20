//! In-memory token-bucket rate limiting.
//!
//! One `TokenBuckets` holds every bucket for a single route group. A bucket
//! starts full with `requests` tokens and refills at `requests` per minute, so
//! "30/min" lets 30 requests arrive at once and then one every two seconds.
//! Counts are per process: with N replicas the real limit is N times higher.

use std::{
    collections::HashMap,
    hash::Hash,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};

use super::{
    ApiError, AppConfig,
    client_ip::{ClientIpSource, ClientKey, peer_address},
};

/// Idle buckets are dropped every this many operations. A bucket that has
/// refilled to capacity is indistinguishable from a fresh one.
const PRUNE_EVERY: u32 = 1024;

pub(crate) struct TokenBuckets<K> {
    capacity: f64,
    refill_per_second: f64,
    state: Mutex<Inner<K>>,
}

struct Inner<K> {
    buckets: HashMap<K, Bucket>,
    operations: u32,
}

#[derive(Clone, Copy)]
struct Bucket {
    tokens: f64,
    updated: Instant,
}

impl<K: Hash + Eq + Clone> TokenBuckets<K> {
    pub(crate) fn per_minute(requests: u32) -> Self {
        let capacity = f64::from(requests.max(1));

        Self {
            capacity,
            refill_per_second: capacity / 60.0,
            state: Mutex::new(Inner {
                buckets: HashMap::new(),
                operations: 0,
            }),
        }
    }

    /// Spend one token, creating the bucket on first use.
    pub(crate) fn acquire(&self, key: &K) -> Result<(), Duration> {
        self.take(key, Instant::now(), true).unwrap_or(Ok(()))
    }

    /// Spend one token only if the bucket already exists. `None` means this key
    /// has never been recorded, so nothing was created.
    pub(crate) fn acquire_existing(&self, key: &K) -> Option<Result<(), Duration>> {
        self.take(key, Instant::now(), false)
    }

    /// Check a bucket without spending from it or creating it.
    pub(crate) fn peek(&self, key: &K) -> Result<(), Duration> {
        self.peek_at(key, Instant::now())
    }

    fn refilled(&self, bucket: Bucket, now: Instant) -> f64 {
        let elapsed = now.saturating_duration_since(bucket.updated).as_secs_f64();
        (bucket.tokens + elapsed * self.refill_per_second).min(self.capacity)
    }

    fn wait_for_one_token(&self, tokens: f64) -> Duration {
        Duration::from_secs_f64(((1.0 - tokens) / self.refill_per_second).max(0.0))
    }

    fn take(&self, key: &K, now: Instant, create: bool) -> Option<Result<(), Duration>> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.operations = state.operations.wrapping_add(1);
        if state.operations.is_multiple_of(PRUNE_EVERY) {
            state
                .buckets
                .retain(|_, bucket| self.refilled(*bucket, now) < self.capacity);
        }
        if !state.buckets.contains_key(key) {
            if !create {
                return None;
            }
            state.buckets.insert(
                key.clone(),
                Bucket {
                    tokens: self.capacity,
                    updated: now,
                },
            );
        }
        let bucket = state
            .buckets
            .get_mut(key)
            .expect("the bucket was inserted above");
        let tokens = self.refilled(*bucket, now);
        bucket.updated = now;
        if tokens < 1.0 {
            bucket.tokens = tokens;
            return Some(Err(self.wait_for_one_token(tokens)));
        }
        bucket.tokens = tokens - 1.0;

        Some(Ok(()))
    }

    fn peek_at(&self, key: &K, now: Instant) -> Result<(), Duration> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        match state.buckets.get(key) {
            Some(bucket) => {
                let tokens = self.refilled(*bucket, now);
                if tokens < 1.0 {
                    Err(self.wait_for_one_token(tokens))
                } else {
                    Ok(())
                }
            }
            None => Ok(()),
        }
    }
}

/// Limits a route group by client IP. Clone it to share one bucket set across
/// several routes.
#[derive(Clone)]
pub(crate) struct IpLimit {
    buckets: Arc<TokenBuckets<ClientKey>>,
    source: ClientIpSource,
}

impl IpLimit {
    pub(crate) fn new(config: &AppConfig, per_minute: u32) -> Self {
        Self {
            buckets: Arc::new(TokenBuckets::per_minute(per_minute)),
            source: ClientIpSource::from_config(config),
        }
    }
}

pub(crate) async fn limit_by_ip(
    State(limit): State<IpLimit>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let key = limit.source.key(request.headers(), peer_address(&request));
    limit
        .buckets
        .acquire(&key)
        .map_err(ApiError::too_many_requests)?;

    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::TokenBuckets;

    #[test]
    fn spends_the_whole_burst_then_refuses() {
        let buckets = TokenBuckets::<u8>::per_minute(3);
        let now = Instant::now();

        for _ in 0..3 {
            assert!(buckets.take(&1, now, true).unwrap().is_ok());
        }
        assert!(buckets.take(&1, now, true).unwrap().is_err());
    }

    #[test]
    fn reports_how_long_until_the_next_token() {
        let buckets = TokenBuckets::<u8>::per_minute(30);
        let now = Instant::now();
        for _ in 0..30 {
            buckets.take(&1, now, true).unwrap().unwrap();
        }

        let wait = buckets.take(&1, now, true).unwrap().unwrap_err();

        assert_eq!(wait, Duration::from_secs(2));
    }

    #[test]
    fn refills_over_time() {
        let buckets = TokenBuckets::<u8>::per_minute(30);
        let now = Instant::now();
        for _ in 0..30 {
            buckets.take(&1, now, true).unwrap().unwrap();
        }

        let later = now + Duration::from_secs(2);

        assert!(buckets.take(&1, later, true).unwrap().is_ok());
        assert!(buckets.take(&1, later, true).unwrap().is_err());
    }

    #[test]
    fn refill_never_exceeds_the_burst() {
        let buckets = TokenBuckets::<u8>::per_minute(2);
        let now = Instant::now();
        buckets.take(&1, now, true).unwrap().unwrap();

        let much_later = now + Duration::from_secs(3600);

        assert!(buckets.take(&1, much_later, true).unwrap().is_ok());
        assert!(buckets.take(&1, much_later, true).unwrap().is_ok());
        assert!(buckets.take(&1, much_later, true).unwrap().is_err());
    }

    #[test]
    fn keys_do_not_share_tokens() {
        let buckets = TokenBuckets::<u8>::per_minute(1);
        let now = Instant::now();

        assert!(buckets.take(&1, now, true).unwrap().is_ok());
        assert!(buckets.take(&1, now, true).unwrap().is_err());
        assert!(buckets.take(&2, now, true).unwrap().is_ok());
    }

    #[test]
    fn existing_only_never_creates_a_bucket() {
        let buckets = TokenBuckets::<u8>::per_minute(1);
        let now = Instant::now();

        assert!(buckets.take(&1, now, false).is_none());
        assert!(buckets.take(&1, now, false).is_none());
        buckets.take(&1, now, true).unwrap().unwrap();
        assert!(buckets.take(&1, now, false).unwrap().is_err());
    }

    #[test]
    fn peek_does_not_spend_or_create() {
        let buckets = TokenBuckets::<u8>::per_minute(1);
        let now = Instant::now();

        assert!(buckets.peek_at(&1, now).is_ok());
        assert!(buckets.peek_at(&1, now).is_ok());
        buckets.take(&1, now, true).unwrap().unwrap();
        assert!(buckets.peek_at(&1, now).is_err());
        assert!(buckets.peek_at(&1, now + Duration::from_secs(60)).is_ok());
    }

    #[test]
    fn idle_buckets_are_pruned() {
        let buckets = TokenBuckets::<u32>::per_minute(1);
        let now = Instant::now();
        buckets.take(&0, now, true).unwrap().unwrap();

        let later = now + Duration::from_secs(120);
        for key in 1..super::PRUNE_EVERY {
            buckets.take(&key, later, true).unwrap().unwrap();
        }

        let state = buckets.state.lock().unwrap();
        assert!(!state.buckets.contains_key(&0));
    }
}
