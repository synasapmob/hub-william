use std::time::Duration;

use reqwest::Client;
use sqlx::PgPool;

use super::AppConfig;

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub http: Client,
    pub gateway_http: Client,
    pub pool: PgPool,
}

pub fn gateway_http_client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("hub-william/", env!("CARGO_PKG_VERSION")))
        .build()
}
