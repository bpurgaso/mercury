use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use fred::prelude::{Builder, ClientLike, RedisConfig, ReconnectPolicy};
use tokio::net::TcpListener;

use mercury_api::{create_router, AppState, ConnectionManager, GlobalWsRateLimiter};
use mercury_core::config::AppConfig;
use mercury_db::pool::create_pool;

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
    let ws_rate_limiter = Arc::new(GlobalWsRateLimiter::new(200));

    let state = AppState {
        db: db_pool,
        redis,
        auth_config: Arc::new(config.auth),
        turn_config: Arc::new(config.turn),
        ws_manager,
        ws_rate_limiter,
        heartbeat_interval_secs: config.server.heartbeat_interval_secs,
        auth_rate_limit_per_min: config.server.auth_rate_limit_per_min,
    };

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
