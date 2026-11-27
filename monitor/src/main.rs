// Skeleton: many fields are wired up in Phase 5. Remove this allow once they are.
#![allow(dead_code)]
//! breakglass-monitor: ingest chain events -> detectors -> alert router -> sinks.
//!
//! Phase 0 skeleton: loads config, wires the pipeline, and runs a heartbeat
//! ingestor so you can see it working. Real ingestors arrive in Phase 5.

mod config;
mod detectors;
mod event;
mod router;
mod sinks;

use std::path::PathBuf;

use clap::Parser;
use tokio::sync::mpsc;

use crate::event::{ChainEvent, Observed};

#[derive(Parser, Debug)]
#[command(about = "Breakglass off-chain monitor")]
struct Args {
    /// Path to config.toml (copy config.example.toml to start)
    #[arg(long, default_value = "config.toml")]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let args = Args::parse();
    let cfg = config::Config::load(&args.config)?;
    tracing::info!(protocol = %cfg.protocol.name, rpcs = cfg.network.rpc_urls.len(), "starting monitor");

    let (tx, mut rx) = mpsc::channel::<Observed>(1024);

    // Phase 5: replace with one logsSubscribe/accountSubscribe ingestor per RPC URL.
    for (i, url) in cfg.network.rpc_urls.iter().enumerate() {
        let tx = tx.clone();
        let source = format!("rpc{i}:{url}");
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(10));
            loop {
                tick.tick().await;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or_default();
                let ev = Observed { signature: None, slot: 0, event: ChainEvent::Heartbeat { source: source.clone(), unix_ts: now } };
                if tx.send(ev).await.is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let mut detectors = detectors::default_set(&cfg.detectors);
    let mut router = router::Router::new(sinks::build(&cfg.alerts.sinks)?);

    loop {
        tokio::select! {
            Some(ev) = rx.recv() => {
                if let ChainEvent::Heartbeat { source, .. } = &ev.event {
                    tracing::debug!(%source, "heartbeat");
                }
                for d in detectors.iter_mut() {
                    for signal in d.observe(&ev) {
                        router.dispatch(&signal);
                    }
                }
            }
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("shutting down");
                break;
            }
        }
    }
    Ok(())
}
