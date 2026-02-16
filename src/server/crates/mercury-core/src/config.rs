use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub redis: RedisConfig,
    pub auth: AuthConfig,
    pub tls: TlsConfig,
}

#[derive(Debug, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DatabaseConfig {
    pub url: String,
    #[serde(default = "default_max_connections")]
    pub max_connections: u32,
    #[serde(default = "default_min_connections")]
    pub min_connections: u32,
    #[serde(default = "default_acquire_timeout_seconds")]
    pub acquire_timeout_seconds: u64,
    #[serde(default = "default_idle_timeout_seconds")]
    pub idle_timeout_seconds: u64,
    #[serde(default = "default_max_lifetime_seconds")]
    pub max_lifetime_seconds: u64,
}

fn default_max_connections() -> u32 {
    50
}
fn default_min_connections() -> u32 {
    5
}
fn default_acquire_timeout_seconds() -> u64 {
    5
}
fn default_idle_timeout_seconds() -> u64 {
    600
}
fn default_max_lifetime_seconds() -> u64 {
    1800
}

#[derive(Debug, Deserialize)]
pub struct RedisConfig {
    pub url: String,
}

#[derive(Debug, Deserialize)]
pub struct AuthConfig {
    pub jwt_secret: String,
}

#[derive(Debug, Deserialize)]
pub struct TlsConfig {
    pub cert_path: String,
    pub key_path: String,
}
