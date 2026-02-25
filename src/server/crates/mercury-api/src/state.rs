use fred::prelude::RedisClient;
use mercury_core::config::{AuthConfig, MediaConfig, TurnConfig};
use mercury_media::SfuHandle;
use sqlx::PgPool;
use std::sync::Arc;

use crate::ws::{ConnectionManager, GlobalWsRateLimiter};

/// Shared application state available to all handlers.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: RedisClient,
    pub auth_config: Arc<AuthConfig>,
    pub turn_config: Arc<TurnConfig>,
    pub media_config: Arc<MediaConfig>,
    pub ws_manager: Arc<ConnectionManager>,
    pub ws_rate_limiter: Arc<GlobalWsRateLimiter>,
    pub sfu_handle: SfuHandle,
    /// Heartbeat interval in seconds (sent to clients in READY, used for timeout checks).
    pub heartbeat_interval_secs: u64,
    /// Max auth requests per IP per minute.
    pub auth_rate_limit_per_min: u64,
}
