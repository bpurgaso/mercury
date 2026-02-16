use fred::prelude::RedisClient;
use mercury_core::config::{AuthConfig, TurnConfig};
use sqlx::PgPool;
use std::sync::Arc;

/// Shared application state available to all handlers.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: RedisClient,
    pub auth_config: Arc<AuthConfig>,
    pub turn_config: Arc<TurnConfig>,
}
