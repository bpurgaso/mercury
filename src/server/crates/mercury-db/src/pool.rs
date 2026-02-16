use std::time::Duration;

use mercury_core::config::DatabaseConfig;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

/// Create a PostgreSQL connection pool from the application's database configuration.
///
/// Applies all pool settings from `DatabaseConfig` including the critical
/// `acquire_timeout` (default 5s) — this ensures the server returns 503
/// instead of stalling when the pool is exhausted under load.
pub async fn create_pool(config: &DatabaseConfig) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(config.max_connections)
        .min_connections(config.min_connections)
        .acquire_timeout(Duration::from_secs(config.acquire_timeout_seconds))
        .idle_timeout(Duration::from_secs(config.idle_timeout_seconds))
        .max_lifetime(Duration::from_secs(config.max_lifetime_seconds))
        .connect(&config.url)
        .await
}

/// Build pool options from config without connecting (useful for testing configuration).
pub fn pool_options(config: &DatabaseConfig) -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(config.max_connections)
        .min_connections(config.min_connections)
        .acquire_timeout(Duration::from_secs(config.acquire_timeout_seconds))
        .idle_timeout(Duration::from_secs(config.idle_timeout_seconds))
        .max_lifetime(Duration::from_secs(config.max_lifetime_seconds))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> DatabaseConfig {
        DatabaseConfig {
            url: "postgres://mercury:mercury@localhost:5432/mercury".to_string(),
            max_connections: 50,
            min_connections: 5,
            acquire_timeout_seconds: 5,
            idle_timeout_seconds: 600,
            max_lifetime_seconds: 1800,
        }
    }

    #[test]
    fn pool_options_applies_config() {
        let config = test_config();
        // Verify pool_options doesn't panic and returns a valid PgPoolOptions
        let _opts = pool_options(&config);
    }

    #[test]
    fn pool_options_with_custom_values() {
        let config = DatabaseConfig {
            url: "postgres://test:test@localhost/test".to_string(),
            max_connections: 10,
            min_connections: 2,
            acquire_timeout_seconds: 3,
            idle_timeout_seconds: 300,
            max_lifetime_seconds: 900,
        };
        let _opts = pool_options(&config);
    }

    #[test]
    fn pool_options_with_default_config() {
        // Verify that a config deserialized with defaults produces valid pool options
        let config: DatabaseConfig =
            toml::from_str(r#"url = "postgres://x:x@localhost/x""#).unwrap();
        assert_eq!(config.max_connections, 50);
        assert_eq!(config.min_connections, 5);
        assert_eq!(config.acquire_timeout_seconds, 5);
        assert_eq!(config.idle_timeout_seconds, 600);
        assert_eq!(config.max_lifetime_seconds, 1800);
        let _opts = pool_options(&config);
    }

    #[tokio::test]
    async fn create_pool_fails_with_invalid_url() {
        let config = DatabaseConfig {
            url: "postgres://invalid:invalid@127.0.0.1:1/nonexistent".to_string(),
            max_connections: 1,
            min_connections: 0,
            acquire_timeout_seconds: 1,
            idle_timeout_seconds: 60,
            max_lifetime_seconds: 60,
        };
        // Should fail to connect (no database at this address)
        let result = create_pool(&config).await;
        assert!(result.is_err());
    }
}
