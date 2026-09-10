use std::{env, net::Ipv6Addr, time::Duration};

use reqwest::Client;
use sqlx::postgres::PgPoolOptions;
use tokio::{net::TcpListener, signal};

const DEFAULT_PORT: u16 = 8080;

fn port() -> Result<u16, Box<dyn std::error::Error>> {
    match env::var("PORT") {
        Ok(value) => Ok(value.parse()?),
        Err(env::VarError::NotPresent) => Ok(DEFAULT_PORT),
        Err(error) => Err(error.into()),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = env::var("DATABASE_URL")?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;

    let address = (Ipv6Addr::UNSPECIFIED, port()?);
    let listener = TcpListener::bind(address).await?;
    let config = hub_william_backend::AppConfig::from_env()?;
    let http = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("hub-william/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let state = hub_william_backend::AppState { config, http, pool };

    println!(
        "hub-william-backend listening on {}",
        listener.local_addr()?
    );

    axum::serve(listener, hub_william_backend::app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let _ = signal::ctrl_c().await;
}
