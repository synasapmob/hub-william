//! What the shop tests share: orders to put in the table, and a bot to talk to.

use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::net::TcpListener;
use uuid::Uuid;

/// An order to put in `telegram_orders`, for a product that need not exist.
pub struct Order {
    pub buyer: i64,
    pub created_ago: &'static str,
    pub first_name: &'static str,
    pub handled_by: Option<Uuid>,
    pub item_title: &'static str,
    pub method: Option<&'static str>,
    pub paid_at: Option<&'static str>,
    pub quantity: i32,
    pub reference: &'static str,
    pub slug: &'static str,
    pub status: &'static str,
    pub unit_price: i64,
    pub username: Option<&'static str>,
}

impl Order {
    pub fn new(reference: &'static str) -> Self {
        Self {
            buyer: 1_000,
            created_ago: "1 hour",
            first_name: "Buyer",
            handled_by: None,
            item_title: "Acme Pro",
            method: None,
            paid_at: None,
            quantity: 1,
            reference,
            slug: "acme-pro",
            status: "awaiting_payment",
            unit_price: 49_000,
            username: Some("buyer"),
        }
    }

    pub fn awaiting(self, created_ago: &'static str) -> Self {
        Self {
            created_ago,
            status: "awaiting_payment",
            ..self
        }
    }

    /// Paid `ago` ago (an interval such as `"2 days"`), by bank transfer unless
    /// told otherwise.
    pub fn paid(self, ago: &'static str) -> Self {
        Self {
            method: self.method.or(Some("bank_transfer")),
            paid_at: Some(ago),
            status: "paid",
            ..self
        }
    }

    /// Made `ago` ago, whatever its status.
    pub fn created(self, ago: &'static str) -> Self {
        Self {
            created_ago: ago,
            ..self
        }
    }

    pub fn cancelled(self) -> Self {
        Self {
            status: "cancelled",
            ..self
        }
    }

    pub fn by(self, buyer: i64, username: Option<&'static str>, first_name: &'static str) -> Self {
        Self {
            buyer,
            first_name,
            username,
            ..self
        }
    }

    pub fn of(self, slug: &'static str, title: &'static str, unit_price: i64) -> Self {
        Self {
            item_title: title,
            slug,
            unit_price,
            ..self
        }
    }

    pub fn quantity(self, quantity: i32) -> Self {
        Self { quantity, ..self }
    }

    pub fn handled(self, by: Uuid, method: &'static str) -> Self {
        Self {
            handled_by: Some(by),
            method: Some(method),
            ..self
        }
    }

    pub async fn insert(self, pool: &PgPool) {
        sqlx::query(
            "INSERT INTO telegram_contacts (telegram_user_id, chat_id, username, first_name)
             VALUES ($1, $1, $2, $3)
             ON CONFLICT (telegram_user_id) DO UPDATE SET username = EXCLUDED.username",
        )
        .bind(self.buyer)
        .bind(self.username)
        .bind(self.first_name)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO telegram_orders
                (id, reference, telegram_user_id, chat_id, item_id, item_title, quantity,
                 unit_price_vnd, total_vnd, status, created_at, expires_at, paid_at,
                 payment_method, handled_by)
             VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $7 * $6, $8,
                     NOW() - ($9::text)::interval,
                     NOW() - ($9::text)::interval + INTERVAL '15 minutes',
                     CASE WHEN $10::text IS NULL THEN NULL
                          WHEN $10 LIKE '____-__-__ %' THEN ($10::text)::timestamptz
                          ELSE NOW() - ($10::text)::interval END,
                     $11, $12)",
        )
        .bind(Uuid::new_v4())
        .bind(self.reference)
        .bind(self.buyer)
        .bind(self.slug)
        .bind(self.item_title)
        .bind(self.quantity)
        .bind(self.unit_price)
        .bind(self.status)
        .bind(self.created_ago)
        .bind(self.paid_at)
        .bind(self.method)
        .bind(self.handled_by)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// What the dashboard sent to the bot: the path, the shared secret it carried,
/// and the body.
pub type Sent = (String, Option<String>, Value);

/// A bot standing in for `apps/telegram`: it writes down what it is asked and
/// answers as it was told to.
#[derive(Clone)]
pub struct FakeBot {
    pub answer: Arc<Mutex<(StatusCode, Value)>>,
    pub received: Arc<Mutex<Vec<Sent>>>,
}

impl FakeBot {
    pub async fn start(status: StatusCode, answer: Value) -> (Self, reqwest::Url) {
        let bot = Self {
            answer: Arc::new(Mutex::new((status, answer))),
            received: Arc::default(),
        };
        let app = Router::new()
            .route("/internal/announce", post(record))
            .route("/internal/payment-notice", post(record))
            .with_state(bot.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();

        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        (
            bot,
            reqwest::Url::parse(&format!("http://{address}")).unwrap(),
        )
    }

    pub fn received(&self) -> Vec<Sent> {
        self.received.lock().unwrap().clone()
    }
}

async fn record(
    State(bot): State<FakeBot>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    bot.received.lock().unwrap().push((
        uri.path().to_owned(),
        headers
            .get("x-hub-william-telegram-token")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        body,
    ));
    let (status, answer) = bot.answer.lock().unwrap().clone();

    (status, Json(answer))
}

/// A product the orders can point at, with a count to take stock from.
pub async fn product(pool: &PgPool, slug: &str, available: i32) {
    let provider: Uuid = sqlx::query_scalar("SELECT id FROM telegram_providers LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO telegram_products
            (id, provider_id, slug, plan, warranty, warranty_note_en, warranty_note_vi,
             price_vnd, available)
         VALUES ($1, $2, $3, 'Pro', 'NW', 'n', 'n', 49000, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(provider)
    .bind(slug)
    .bind(available)
    .execute(pool)
    .await
    .unwrap();
}

pub fn announced(text: &str) -> Value {
    json!({ "text": text })
}
