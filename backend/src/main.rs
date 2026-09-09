use std::{env, net::Ipv4Addr};

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
    let address = (Ipv4Addr::UNSPECIFIED, port()?);
    let listener = TcpListener::bind(address).await?;

    println!(
        "hub-william-backend listening on {}",
        listener.local_addr()?
    );

    axum::serve(listener, hub_william_backend::app())
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let _ = signal::ctrl_c().await;
}
