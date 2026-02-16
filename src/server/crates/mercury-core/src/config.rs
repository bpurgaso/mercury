use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub redis: RedisConfig,
    pub auth: AuthConfig,
    pub tls: TlsConfig,
    #[serde(default)]
    pub turn: TurnConfig,
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

#[derive(Debug, Clone, Deserialize)]
pub struct RedisConfig {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthConfig {
    pub jwt_secret: String,
    #[serde(default = "default_jwt_expiry_minutes")]
    pub jwt_expiry_minutes: u64,
    #[serde(default = "default_refresh_token_expiry_days")]
    pub refresh_token_expiry_days: u64,
    #[serde(default = "default_argon2_memory_kib")]
    pub argon2_memory_kib: u32,
    #[serde(default = "default_argon2_iterations")]
    pub argon2_iterations: u32,
    #[serde(default = "default_argon2_parallelism")]
    pub argon2_parallelism: u32,
}

fn default_jwt_expiry_minutes() -> u64 {
    60
}
fn default_refresh_token_expiry_days() -> u64 {
    30
}
fn default_argon2_memory_kib() -> u32 {
    65536
}
fn default_argon2_iterations() -> u32 {
    3
}
fn default_argon2_parallelism() -> u32 {
    4
}

#[derive(Debug, Clone, Deserialize)]
pub struct TurnConfig {
    #[serde(default = "default_turn_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub secret: String,
    #[serde(default = "default_turn_urls")]
    pub urls: Vec<String>,
    #[serde(default = "default_turn_credential_ttl_seconds")]
    pub credential_ttl_seconds: u64,
}

impl Default for TurnConfig {
    fn default() -> Self {
        Self {
            enabled: default_turn_enabled(),
            secret: String::new(),
            urls: default_turn_urls(),
            credential_ttl_seconds: default_turn_credential_ttl_seconds(),
        }
    }
}

fn default_turn_enabled() -> bool {
    false
}
fn default_turn_urls() -> Vec<String> {
    vec![]
}
fn default_turn_credential_ttl_seconds() -> u64 {
    86400
}

#[derive(Debug, Deserialize)]
pub struct TlsConfig {
    pub cert_path: String,
    pub key_path: String,
}
