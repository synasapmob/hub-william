use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use chrono::{DateTime, FixedOffset, TimeDelta, Utc};
use reqwest::Url;
use serde::Deserialize;

use crate::catalog::CatalogItem;

pub const ORDER_LIFETIME_MINUTES: i64 = 15;
const SELECTION_LIFETIME_MINUTES: i64 = 30;
const VIETNAM_UTC_OFFSET_SECONDS: i32 = 7 * 3_600;
const QR_IMAGE_PATH: &str = "/qr.png";
const PROVIDERS_IMAGE_PATH: &str = "/providers.png";

/// An order as `apps/api` owns it. The adapter never stores one; every payment
/// screen reads the order back by its reference, so a redeploy cannot lose a
/// buyer's checkout and a stale button cannot resurrect a settled one.
#[derive(Clone, Deserialize)]
pub struct Order {
    pub chat_id: i64,
    pub expires_at: DateTime<Utc>,
    pub item_title: String,
    pub quantity: i64,
    pub reference: String,
    pub status: String,
    pub telegram_user_id: i64,
    pub total_vnd: i64,
    pub unit_price_vnd: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    AwaitingPayment,
    Cancelled,
    Paid,
    Unknown,
}

impl Order {
    pub fn status(&self) -> OrderStatus {
        match self.status.as_str() {
            "awaiting_payment" => OrderStatus::AwaitingPayment,
            "cancelled" => OrderStatus::Cancelled,
            "paid" => OrderStatus::Paid,
            _ => OrderStatus::Unknown,
        }
    }

    pub fn has_expired(&self) -> bool {
        self.status() == OrderStatus::AwaitingPayment && self.expires_at <= Utc::now()
    }
}

/// The one piece of checkout state that is genuinely ephemeral: which package a
/// buyer tapped, so the next bare number in the chat has something to price.
#[derive(Clone, Default)]
pub struct Sessions {
    entries: Arc<Mutex<HashMap<i64, Selection>>>,
}

#[derive(Clone)]
struct Selection {
    expires_at: DateTime<Utc>,
    item: CatalogItem,
}

impl Sessions {
    pub fn choose(&self, telegram_user_id: i64, item: CatalogItem) {
        self.write(|entries| {
            entries.insert(
                telegram_user_id,
                Selection {
                    expires_at: Utc::now() + TimeDelta::minutes(SELECTION_LIFETIME_MINUTES),
                    item,
                },
            );
        });
    }

    pub fn chosen_item(&self, telegram_user_id: i64) -> Option<CatalogItem> {
        self.write(|entries| entries.get(&telegram_user_id).map(|entry| entry.item))
    }

    pub fn clear(&self, telegram_user_id: i64) {
        self.write(|entries| entries.remove(&telegram_user_id));
    }

    fn write<T>(&self, action: impl FnOnce(&mut HashMap<i64, Selection>) -> T) -> T {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Utc::now();
        entries.retain(|_, entry| entry.expires_at > now);
        action(&mut entries)
    }
}

pub fn memo(prefix: &str, reference: &str) -> String {
    format!("{prefix} {reference}")
}

/// Vietnamese banking hours are what a buyer reads on the panel, so the expiry
/// is always rendered at UTC+7 regardless of where the adapter runs.
pub fn format_expiry(at: DateTime<Utc>) -> String {
    let offset =
        FixedOffset::east_opt(VIETNAM_UTC_OFFSET_SECONDS).expect("UTC+7 is a valid fixed offset");
    at.with_timezone(&offset)
        .format("%H:%M %d/%m/%Y")
        .to_string()
}

/// Telegram fetches an image over the public internet, so both the QR and the
/// provider marks are served from this service's own origin.
pub fn qr_image_url(public_url: &Url) -> Option<String> {
    Some(public_url.join(QR_IMAGE_PATH).ok()?.to_string())
}

pub fn providers_image_url(public_url: &Url) -> Option<String> {
    Some(public_url.join(PROVIDERS_IMAGE_PATH).ok()?.to_string())
}

/// Rounds up so a buyer never under-pays by a fraction of a cent.
pub fn usdt_amount(total_vnd: i64, vnd_rate: i64) -> String {
    let total = u64::try_from(total_vnd).unwrap_or_default();
    let rate = u64::try_from(vnd_rate).unwrap_or(1).max(1);
    let cents = total.saturating_mul(100).div_ceil(rate);
    format!("{}.{:02}", cents / 100, cents % 100)
}

#[cfg(test)]
mod tests {
    use chrono::{TimeDelta, TimeZone, Utc};
    use reqwest::Url;

    use super::{Order, OrderStatus, Sessions, format_expiry, memo, qr_image_url, usdt_amount};
    use crate::catalog::find;

    #[test]
    fn an_expiry_is_rendered_in_vietnam_local_time() {
        let at = Utc
            .with_ymd_and_hms(2026, 9, 10, 8, 31, 0)
            .single()
            .expect("a valid instant");

        assert_eq!(format_expiry(at), "15:31 10/09/2026");
    }

    #[test]
    fn a_transfer_memo_joins_the_prefix_and_the_reference() {
        assert_eq!(
            memo("CAM TIEN DI CHILL THOI", "1GS0H75MMX9P"),
            "CAM TIEN DI CHILL THOI 1GS0H75MMX9P"
        );
    }

    #[test]
    fn the_qr_is_served_from_this_service_origin() {
        let public_url = Url::parse("https://telegram-production-e4cf.up.railway.app").unwrap();

        assert_eq!(
            qr_image_url(&public_url).unwrap(),
            "https://telegram-production-e4cf.up.railway.app/qr.png"
        );
    }

    #[test]
    fn a_usdt_amount_rounds_up_to_the_cent() {
        assert_eq!(usdt_amount(260_000, 26_000), "10.00");
        assert_eq!(usdt_amount(270_000, 26_000), "10.39");
        assert_eq!(usdt_amount(1, 26_000), "0.01");
    }

    #[test]
    fn an_order_reads_its_status_and_expiry() {
        let awaiting = order("awaiting_payment", 5);
        assert_eq!(awaiting.status(), OrderStatus::AwaitingPayment);
        assert!(!awaiting.has_expired());

        assert!(order("awaiting_payment", -5).has_expired());
        // A settled order is never "expired" — the money already arrived.
        assert!(!order("paid", -5).has_expired());
        assert_eq!(order("paid", 5).status(), OrderStatus::Paid);
        assert_eq!(order("cancelled", 5).status(), OrderStatus::Cancelled);
        assert_eq!(order("something_new", 5).status(), OrderStatus::Unknown);
    }

    #[test]
    fn a_selection_is_per_buyer_and_clearable() {
        let sessions = Sessions::default();
        let item = find("claude-max-x20").expect("seeded package");

        sessions.choose(7, item);
        assert!(sessions.chosen_item(7).is_some());
        assert!(sessions.chosen_item(8).is_none());

        sessions.clear(7);
        assert!(sessions.chosen_item(7).is_none());
    }

    fn order(status: &str, expires_in_minutes: i64) -> Order {
        Order {
            chat_id: 123,
            expires_at: Utc::now() + TimeDelta::minutes(expires_in_minutes),
            item_title: "Claude MAX X20 (Personal) · 1M".to_owned(),
            quantity: 2,
            reference: "1GS0H75MMX9P".to_owned(),
            status: status.to_owned(),
            telegram_user_id: 456,
            total_vnd: 270_000,
            unit_price_vnd: 135_000,
        }
    }
}
