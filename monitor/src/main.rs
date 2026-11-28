//! breakglass-monitor: ingest chain events -> detectors -> alert router -> sinks,
//! with a Postgres store and the admin HTTP API (docs/FRONTEND.md section 7).

mod api;
mod bot;
mod config;
mod decode;
mod detectors;
mod event;
mod health;
mod ingest;
mod pipeline;
mod router;
mod sinks;
mod store;

#[cfg(test)]
mod db_tests;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use tokio::sync::{broadcast, mpsc};

#[derive(Parser, Debug)]
#[command(about = "Breakglass off-chain monitor")]
struct Args {
    /// Path to config.toml (copy config.example.toml to start)
    #[arg(long, default_value = "config.toml")]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // .env next to the config (or in the working directory); real env vars win.
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse()?),
        )
        .with_writer(std::io::stderr)
        .init();

    let args = Args::parse();
    let cfg = config::Config::load(&args.config)?;
    let sinks = sinks::build(&cfg.alerts.sinks)?;
    let db_url = std::env::var("DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("DATABASE_URL must be set (monitor/.env)"))?;
    let store = store::Store::connect(&db_url).await?;
    let protocol_id = store
        .protocol(
            &cfg.protocol.name,
            &cfg.protocol.breakglass_program,
            &cfg.protocol.protected_program,
        )
        .await?;

    let now = event::now_secs();
    let sources = cfg.sources();
    let health = health::Health::new(
        sources
            .iter()
            .cloned()
            .zip(cfg.network.rpc_urls.iter().cloned())
            .collect(),
        cfg.detectors.heartbeat_timeout_secs as i64,
        now,
    );
    let (stream_tx, _) = broadcast::channel(1024);
    let router = router::Router::new(
        store.clone(),
        protocol_id,
        cfg.protocol.name.clone(),
        cfg.alerts.clone(),
        sinks,
        stream_tx.clone(),
    );
    let detectors = detectors::default_set(
        &cfg.detectors,
        sources.clone(),
        vec![
            (cfg.protocol.breakglass_program.clone(), "breakglass".into()),
            (
                cfg.protocol.protected_program.clone(),
                cfg.protocol.name.clone(),
            ),
        ],
        now,
        seeds(&store, protocol_id).await?,
    );
    let seen = Arc::new(ingest::Seen::new(50_000));

    // Admin API.
    let api_state = api::ApiState {
        store: store.clone(),
        health: health.clone(),
        stream: stream_tx.clone(),
        token: std::env::var("MONITOR_API_TOKEN")
            .ok()
            .filter(|t| !t.trim().is_empty()),
    };
    if api_state.token.is_none() {
        tracing::warn!("MONITOR_API_TOKEN is not set: POST /incidents/:id/ack is disabled");
    }
    let app = api::router(api_state, &cfg.api.cors_origins)?;
    let listener = tokio::net::TcpListener::bind(&cfg.api.bind).await?;
    tracing::info!(bind = %cfg.api.bind, "api listening");
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(error = %e, "api server stopped");
        }
    });

    // Ingestors.
    let watch = Arc::new(ingest::Watch::new(
        &cfg.protocol.breakglass_program,
        &cfg.protocol.protected_program,
        &cfg.protocol.vault_token_accounts,
        &cfg.detectors.flagged_funders,
    )?);
    let (tx, mut rx) = mpsc::channel::<ingest::Ingest>(4096);
    for (i, source) in sources.iter().enumerate() {
        ingest::spawn(
            source.clone(),
            cfg.network.rpc_urls[i].clone(),
            cfg.network.ws_urls[i].clone(),
            watch.clone(),
            tx.clone(),
            seen.clone(),
        );
    }
    drop(tx);

    // Guardian bot (opt-in).
    let bot_tx = if cfg.bot.enabled {
        let path = std::env::var("GUARDIAN_KEYPAIR_PATH")
            .ok()
            .filter(|p| !p.trim().is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!("[bot] enabled = true needs GUARDIAN_KEYPAIR_PATH (monitor/.env)")
            })?;
        let signer: Arc<dyn bot::GuardianSigner> = Arc::new(bot::FileSigner::load(&path)?);
        let accounts = bot::Accounts::new(
            cfg.protocol.breakglass_program.parse()?,
            cfg.protocol.protected_program.parse()?,
        );
        let guardian_bot = bot::Bot::new(
            cfg.bot.clone(),
            signer,
            accounts,
            &cfg.network.rpc_urls,
            store.clone(),
            protocol_id,
        );
        guardian_bot.check_guardian().await?;
        let (btx, brx) = mpsc::channel(1024);
        tokio::spawn(guardian_bot.run(brx));
        Some(btx)
    } else {
        tracing::info!("guardian bot disabled ([bot] enabled = false)");
        None
    };

    let mut pipeline = pipeline::Pipeline::new(
        store,
        protocol_id,
        detectors,
        router.clone(),
        seen,
        health,
        stream_tx,
    );
    pipeline.bot = bot_tx;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut repage = tokio::time::interval(Duration::from_secs(5));
    tracing::info!(protocol = %cfg.protocol.name, rpcs = sources.len(), "monitor ready");
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(m) => pipeline.handle(m).await,
                None => break,
            },
            _ = tick.tick() => pipeline.tick().await,
            _ = repage.tick() => router.tick().await,
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("shutting down");
                break;
            }
        }
    }
    Ok(())
}

/// History the detectors need at startup.
async fn seeds(store: &store::Store, protocol_id: i32) -> anyhow::Result<detectors::Seeds> {
    let (books, holds) = store.deposit_seed(protocol_id).await?;
    Ok(detectors::Seeds {
        history_start: store.history_start(protocol_id).await?,
        velocity: store.velocity_seed(protocol_id).await?,
        books,
        holds,
    })
}
