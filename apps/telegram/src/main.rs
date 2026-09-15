mod app;
mod catalog;
mod checkout;
mod config;
mod language;
mod telegram;
mod view;

use std::{
    env,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    time::Duration,
};

use reqwest::Client;
use tokio::{net::TcpListener, signal};

use crate::{app::AppState, checkout::Sessions, config::AppConfig};

const DEFAULT_PORT: u16 = 8090;

fn port() -> Result<u16, Box<dyn std::error::Error>> {
    match env::var("PORT") {
        Ok(value) => Ok(value.parse()?),
        Err(env::VarError::NotPresent) => Ok(DEFAULT_PORT),
        Err(error) => Err(error.into()),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = AppConfig::from_env()?;
    let http = Client::builder()
        .local_address(Some(IpAddr::V4(Ipv4Addr::UNSPECIFIED)))
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("hub-william-telegram/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let listener = TcpListener::bind((Ipv6Addr::UNSPECIFIED, port()?)).await?;

    println!(
        "hub-william-telegram listening on {}",
        listener.local_addr()?
    );

    axum::serve(
        listener,
        app::router(AppState {
            config,
            http,
            sessions: Sessions::default(),
        }),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    Ok(())
}

async fn shutdown_signal() {
    let _ = signal::ctrl_c().await;
}
