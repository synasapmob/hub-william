use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use chrono::{DateTime, FixedOffset, TimeDelta, Utc};
use reqwest::Url;
use serde::Deserialize;

use crate::config::BankAccount;

/// How long a buyer has to pay. After it the order is void: a transfer that
/// the bank made later no longer settles it.
pub const ORDER_LIFETIME_MINUTES: i64 = 5;
const SELECTION_LIFETIME_MINUTES: i64 = 30;
const VIETNAM_UTC_OFFSET_SECONDS: i32 = 7 * 3_600;
const QR_IMAGE_ENDPOINT: &str = "https://vietqr.app/img";

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

/// What the next plain message from a chat means. It is the only state the
/// adapter keeps, and it expires on its own, because everything durable lives
/// in `apps/api`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pending {
    /// The owner is describing a product to create.
    NewProduct,
    /// The owner is setting this product's price.
    Price(String),
    /// A buyer is choosing how many of this product to buy.
    Quantity(String),
    /// The owner is adding stock to this product.
    Restock(String),
}

#[derive(Clone, Default)]
pub struct Sessions {
    entries: Arc<Mutex<HashMap<i64, Entry>>>,
}

#[derive(Clone)]
struct Entry {
    expires_at: DateTime<Utc>,
    pending: Pending,
}

impl Sessions {
    pub fn expect(&self, telegram_user_id: i64, pending: Pending) {
        self.write(|entries| {
            entries.insert(
                telegram_user_id,
                Entry {
                    expires_at: Utc::now() + TimeDelta::minutes(SELECTION_LIFETIME_MINUTES),
                    pending,
                },
            );
        });
    }

    pub fn pending(&self, telegram_user_id: i64) -> Option<Pending> {
        self.write(|entries| {
            entries
                .get(&telegram_user_id)
                .map(|entry| entry.pending.clone())
        })
    }

    pub fn clear(&self, telegram_user_id: i64) {
        self.write(|entries| entries.remove(&telegram_user_id));
    }

    fn write<T>(&self, action: impl FnOnce(&mut HashMap<i64, Entry>) -> T) -> T {
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

/// A VietQR image of this order, with the account, amount and note already in
/// it, so the buyer scans and pays without typing either. Telegram fetches a
/// photo by URL, so the image comes from SePay's QR service rather than from
/// this one. The service reads the bank name in any case.
pub fn qr_image_url(bank: &BankAccount, total_vnd: i64, memo: &str) -> String {
    let total = total_vnd.to_string();
    let url = Url::parse_with_params(
        QR_IMAGE_ENDPOINT,
        [
            ("acc", bank.number.as_str()),
            ("amount", total.as_str()),
            ("bank", bank.name.as_str()),
            ("des", memo),
            ("fullacc", "true"),
            ("holder", bank.holder.as_str()),
            ("showinfo", "true"),
        ],
    )
    .expect("the QR endpoint is a valid URL");

    url.into()
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

    use crate::config::BankAccount;

    use super::{
        ORDER_LIFETIME_MINUTES, Order, OrderStatus, Pending, Sessions, format_expiry, memo,
        qr_image_url, usdt_amount,
    };

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
    fn the_qr_carries_the_account_the_amount_and_the_note() {
        let bank = BankAccount {
            holder: "NGUYEN VAN A".to_owned(),
            name: "MBBANK".to_owned(),
            number: "0123456789".to_owned(),
        };

        assert_eq!(
            qr_image_url(&bank, 270_000, "MOT NGAY VUI VE 1GS0H75MMX9P"),
            "https://vietqr.app/img?acc=0123456789&amount=270000&bank=MBBANK&des=MOT+NGAY+VUI+VE+1GS0H75MMX9P&fullacc=true&holder=NGUYEN+VAN+A&showinfo=true"
        );
    }

    #[test]
    fn a_usdt_amount_rounds_up_to_the_cent() {
        assert_eq!(usdt_amount(260_000, 26_000), "10.00");
        assert_eq!(usdt_amount(270_000, 26_000), "10.39");
        assert_eq!(usdt_amount(1, 26_000), "0.01");
    }

    #[test]
    fn a_buyer_has_five_minutes_to_pay() {
        assert_eq!(ORDER_LIFETIME_MINUTES, 5);
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
    fn a_pending_action_is_per_person_and_clearable() {
        let sessions = Sessions::default();

        sessions.expect(7, Pending::Quantity("claude-pro".to_owned()));
        sessions.expect(8, Pending::Restock("claude-pro".to_owned()));

        assert_eq!(
            sessions.pending(7),
            Some(Pending::Quantity("claude-pro".to_owned()))
        );
        assert_eq!(
            sessions.pending(8),
            Some(Pending::Restock("claude-pro".to_owned()))
        );
        assert!(sessions.pending(9).is_none());

        // The newest expectation wins, so a tap always redirects the next message.
        sessions.expect(7, Pending::NewProduct);
        assert_eq!(sessions.pending(7), Some(Pending::NewProduct));

        sessions.clear(7);
        assert!(sessions.pending(7).is_none());
        assert!(sessions.pending(8).is_some());
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
