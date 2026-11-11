//! Who is calling the API with a key, and what that caller may do.
//!
//! A key is issued in `SHOP_KEYS` as `name:key`. The key says who is calling; the
//! table below says what that name may do, so a permission is reviewed in a pull
//! request and not typed into an environment variable. Handlers ask for a
//! [`Permission`] and never compare a name, which keeps adding a caller to one line.

use axum::http::{HeaderMap, HeaderValue, header::AUTHORIZATION};

use crate::core::{ApiError, AppConfig, TELEGRAM_KEY_NAME};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Permission {
    /// Everything the Telegram bot does through `/internal/telegram/*`.
    Internal,
    /// `GET /partner/products`.
    ProductsRead,
}

/// What each name may do. A name that is not here may do nothing, so a key added to
/// `SHOP_KEYS` before its line is added here opens nothing. `Internal` belongs to the
/// bot alone.
const GRANTS: &[(&str, &[Permission])] = &[
    (TELEGRAM_KEY_NAME, &[Permission::Internal]),
    ("shop_1", &[Permission::ProductsRead]),
    ("shop_2", &[Permission::ProductsRead]),
];

/// The header the Telegram bot has always sent its key in. Partners use
/// `Authorization: Bearer`; this one is still read for every key.
const BOT_KEY_HEADER: &str = "x-hub-william-telegram-token";

/// A request that presented an issued key.
#[derive(Clone, Debug)]
pub(crate) struct Caller {
    name: String,
}

impl Caller {
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn can(&self, permission: Permission) -> bool {
        GRANTS
            .iter()
            .any(|(name, granted)| *name == self.name && granted.contains(&permission))
    }

    pub(crate) fn require(&self, permission: Permission) -> Result<(), ApiError> {
        self.can(permission)
            .then_some(())
            .ok_or(ApiError::Forbidden)
    }
}

/// The key a request carries: a bearer token, else the bot's header.
fn presented_key(headers: &HeaderMap) -> Option<&[u8]> {
    let bearer = headers
        .get(AUTHORIZATION)
        .map(HeaderValue::as_bytes)
        .and_then(|value| {
            let (scheme, key) = value.split_at_checked("Bearer ".len())?;
            scheme.eq_ignore_ascii_case(b"Bearer ").then_some(key)
        });

    bearer
        .or_else(|| headers.get(BOT_KEY_HEADER).map(HeaderValue::as_bytes))
        .map(<[u8]>::trim_ascii)
        .filter(|key| !key.is_empty())
}

/// Who the request's key was issued to, or `None` when it carries no issued key.
pub(crate) fn identify(config: &AppConfig, headers: &HeaderMap) -> Option<Caller> {
    let received = presented_key(headers)?;
    let mut matched = None;

    // Every key is compared, so the time taken does not say which one matched.
    for (name, key) in config.issued_keys() {
        if secrets_match(key, received) && matched.is_none() {
            matched = Some(name);
        }
    }

    matched.map(|name| Caller {
        name: name.to_owned(),
    })
}

pub(crate) fn secrets_match(expected: &[u8], received: &[u8]) -> bool {
    let mut difference = expected.len() ^ received.len();
    let length = expected.len().max(received.len());

    for index in 0..length {
        let expected_byte = expected.get(index).copied().unwrap_or(0);
        let received_byte = received.get(index).copied().unwrap_or(0);
        difference |= usize::from(expected_byte ^ received_byte);
    }

    difference == 0
}
