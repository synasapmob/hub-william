use std::{env, process::ExitCode, time::Duration};

use hub_william_backend::{
    AppConfig, AppState, ProviderCredentialRefreshStatus, gateway_http_client,
    refresh_all_provider_credentials,
};
use reqwest::Client;
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() -> ExitCode {
    if env::args().skip(1).collect::<Vec<_>>() != ["--all"] {
        eprintln!("Usage: cargo run --example refresh_provider_credentials -- --all");
        return ExitCode::from(2);
    }
    match run().await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(()) => {
            eprintln!(
                "Credential maintenance could not complete; sensitive error details withheld."
            );
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<bool, ()> {
    let config = AppConfig::from_env().map_err(|_| ())?;
    let database_url = env::var("DATABASE_URL").map_err(|_| ())?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .map_err(|_| ())?;
    let http = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("hub-william/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| ())?;
    let state = AppState {
        config,
        http,
        gateway_http: gateway_http_client().map_err(|_| ())?,
        pool,
    };
    let results = refresh_all_provider_credentials(&state)
        .await
        .map_err(|_| ())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&results).map_err(|_| ())?
    );
    Ok(results
        .iter()
        .all(|result| matches!(result.status, ProviderCredentialRefreshStatus::Refreshed)))
}
