use std::{env, net::Ipv6Addr, time::Duration};

use reqwest::Client;
use sqlx::postgres::PgPoolOptions;
use tokio::{
    net::TcpListener,
    signal,
    time::{MissedTickBehavior, interval},
};

const DEFAULT_PORT: u16 = 8080;
const PROVIDER_CREDENTIAL_SWEEP_SECONDS: u64 = 60;

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
    let gateway_http = hub_william_backend::gateway_http_client()?;
    let state = hub_william_backend::AppState {
        config,
        http,
        gateway_http,
        pool,
    };
    let refreshed_connection_metadata =
        hub_william_backend::refresh_stored_connection_metadata(&state).await?;

    println!(
        "hub-william-backend listening on {}; refreshed {refreshed_connection_metadata} connection metadata records",
        listener.local_addr()?,
    );

    let credential_refresh_state = state.clone();
    let credential_refresh_task = tokio::spawn(async move {
        let mut sweep = interval(Duration::from_secs(PROVIDER_CREDENTIAL_SWEEP_SECONDS));
        sweep.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            sweep.tick().await;
            match hub_william_backend::refresh_due_provider_credentials(&credential_refresh_state)
                .await
            {
                Ok(summary)
                    if summary.refreshed > 0
                        || summary.reauthorization_required > 0
                        || summary.failed > 0 =>
                {
                    println!(
                        "provider credential sweep: {} refreshed, {} need reauthorization, {} failed",
                        summary.refreshed, summary.reauthorization_required, summary.failed
                    );
                }
                Ok(_) => {}
                Err(error) => eprintln!("provider credential sweep failed: {error}"),
            }
        }
    });

    axum::serve(listener, hub_william_backend::app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    credential_refresh_task.abort();

    Ok(())
}

async fn shutdown_signal() {
    let _ = signal::ctrl_c().await;
}
