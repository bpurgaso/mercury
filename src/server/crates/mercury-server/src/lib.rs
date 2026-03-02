use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use fred::prelude::{Builder, ClientLike, RedisConfig, ReconnectPolicy};
use tokio::net::TcpListener;

use mercury_api::{create_router, init_metrics, spawn_abuse_detector, spawn_sfu_event_consumer, AppState, ConnectionManager, GlobalWsRateLimiter};
use mercury_core::config::AppConfig;
use mercury_db::pool::create_pool;
use mercury_media::start_sfu;

/// Start the Mercury server without TLS on the given address.
///
/// Returns the bound `SocketAddr` (useful when binding to port 0 for tests).
/// The server runs as a background tokio task and will shut down when the
/// runtime is dropped.
pub async fn start_server(config: AppConfig) -> Result<SocketAddr> {
    let db_pool = create_pool(&config.database)
        .await
        .context("failed to create database pool")?;

    sqlx::migrate!("../../migrations")
        .run(&db_pool)
        .await
        .context("failed to run database migrations")?;

    let redis_config =
        RedisConfig::from_url(&config.redis.url).context("invalid Redis URL")?;
    let redis = Builder::from_config(redis_config)
        .with_connection_config(|c| {
            c.connection_timeout = std::time::Duration::from_secs(5);
        })
        .set_policy(ReconnectPolicy::new_exponential(0, 100, 5000, 2))
        .build()?;
    redis
        .init()
        .await
        .context("failed to connect to Redis")?;

    let ws_manager = Arc::new(ConnectionManager::new());
    let ws_rate_limiter = Arc::new(GlobalWsRateLimiter::new(config.server.ws_rate_limit_per_sec));

    // Start the SFU on a dedicated runtime
    let (sfu_handle, sfu_event_rx) = start_sfu(&config.media);

    // Initialize Prometheus metrics
    let metrics_handle = init_metrics();
    let start_time = Instant::now();

    let cors_origins = config.server.cors_origins.clone();

    let state = AppState {
        db: db_pool,
        redis,
        auth_config: Arc::new(config.auth),
        turn_config: Arc::new(config.turn),
        media_config: Arc::new(config.media),
        moderation_config: Arc::new(config.moderation),
        ws_manager,
        ws_rate_limiter,
        sfu_handle,
        heartbeat_interval_secs: config.server.heartbeat_interval_secs,
        auth_rate_limit_per_min: config.server.auth_rate_limit_per_min,
        metrics_handle,
        start_time,
        cors_origins,
    };

    // Spawn the SFU event consumer (dispatches SFU events to WebSocket clients)
    spawn_sfu_event_consumer(state.clone(), sfu_event_rx);

    // Spawn the abuse detector background task
    spawn_abuse_detector(state.clone());

    let app = create_router(state);

    let addr: SocketAddr = format!("{}:{}", config.server.host, config.server.port)
        .parse()
        .context("invalid server address")?;
    let listener = TcpListener::bind(addr).await?;
    let bound_addr = listener.local_addr()?;

    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .ok();
    });

    Ok(bound_addr)
}
