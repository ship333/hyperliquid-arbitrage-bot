use anyhow::Result;
use dotenvy::dotenv;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::env;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;
use std::time::Duration;

use redis::aio::ConnectionManager;
use redis::AsyncCommands;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Opportunity {
    pair: String,
    spread_bps: f64,
    est_gas_usd: f64,
    est_profit_usd: f64,
    liquidity_usd: f64,
    confidence: f64,
    route: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv().ok();
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .with_env_filter("info")
        .finish();
    tracing::subscriber::set_global_default(subscriber).ok();

    info!("starting hyperliquid arbitrage engine (stub)");

    let subgraph = env::var("PRJX_SUBGRAPH").unwrap_or_else(|_|
        "https://api.goldsky.com/api/public/project_cmbbm2iwckb1b01t39xed236t/subgraphs/uniswap-v3-hyperevm-position/prod/gn".to_string()
    );

    // Optional Redis wiring
    let redis_url = env::var("REDIS_URL").ok();
    let redis_channel = env::var("REDIS_CHANNEL").unwrap_or_else(|_| "arb:realtime".to_string());
    let mut redis_mgr: Option<ConnectionManager> = None;
    if let Some(url) = redis_url.clone() {
        match redis::Client::open(url) {
            Ok(client) => match client.get_tokio_connection_manager().await {
                Ok(conn) => {
                    info!("connected to redis");
                    redis_mgr = Some(conn);
                }
                Err(e) => info!(error = %e, "failed to connect redis"),
            },
            Err(e) => info!(error = %e, "invalid REDIS_URL"),
        }
    } else {
        info!("REDIS_URL not set; publisher disabled");
    }

    let client = Client::new();

    let query = r#"query Pools($first: Int!) { pools(first: $first, orderBy: volumeUSD, orderDirection: desc) { id liquidity sqrtPrice tick feeTier } }"#;
    let body = json!({"query": query, "variables": {"first": 1}});

    let resp = client.post(&subgraph).json(&body).send().await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    info!(%status, %text, "sample PRJX GraphQL response");

    // TODO: connect to HyperSwap SDK/Router via RPC and price checks
    // TODO: opportunity detection + signaling to backend

    // Heartbeat publishing loop (if Redis connected)
    if let Some(mut conn) = redis_mgr {
        loop {
            let payload = json!({
                "ts": chrono::Utc::now().to_rfc3339(),
                "pnl": 12.34,
                "opportunities": [],
                "engine": {"status": "running"}
            })
            .to_string();
            let _: () = conn.publish::<_, _, ()>(&redis_channel, payload).await.unwrap_or(());
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
    }

    Ok(())
}
