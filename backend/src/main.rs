use anyhow::Result;
use remi::{app, build_state};
use std::{env, path::PathBuf};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let data_dir = PathBuf::from(env::var("REMI_DATA_DIR").unwrap_or_else(|_| "./data".into()));
    let web_dir = env::var("REMI_WEB_DIR").ok().map(PathBuf::from);
    let bind = env::var("REMI_BIND").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let state = build_state(data_dir).await?;
    let listener = TcpListener::bind(&bind).await?;
    tracing::info!(%bind,"ReMi Rust backend listening");
    axum::serve(listener, app(state, web_dir)).await?;
    Ok(())
}
