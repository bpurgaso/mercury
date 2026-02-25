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
    #[serde(default)]
    pub media: MediaConfig,
}

#[derive(Debug, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    #[serde(default = "default_heartbeat_interval_secs")]
    pub heartbeat_interval_secs: u64,
    #[serde(default = "default_auth_rate_limit_per_min")]
    pub auth_rate_limit_per_min: u64,
    #[serde(default = "default_ws_rate_limit_per_sec")]
    pub ws_rate_limit_per_sec: u64,
}

fn default_auth_rate_limit_per_min() -> u64 {
    5
}

fn default_ws_rate_limit_per_sec() -> u64 {
    200
}

fn default_heartbeat_interval_secs() -> u64 {
    30
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

// ── Media / SFU Configuration ───────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct MediaConfig {
    #[serde(default = "default_dedicated_cores")]
    pub dedicated_cores: usize,
    #[serde(default = "default_max_participants_per_room")]
    pub max_participants_per_room: usize,
    #[serde(default = "default_empty_room_timeout_secs")]
    pub empty_room_timeout_secs: u64,
    #[serde(default = "default_udp_port_range_start")]
    pub udp_port_range_start: u16,
    #[serde(default = "default_udp_port_range_end")]
    pub udp_port_range_end: u16,
    #[serde(default)]
    pub ice: IceConfig,
    #[serde(default)]
    pub audio: AudioConfig,
    #[serde(default)]
    pub video: VideoConfig,
    #[serde(default)]
    pub bandwidth: BandwidthConfig,
}

impl Default for MediaConfig {
    fn default() -> Self {
        Self {
            dedicated_cores: default_dedicated_cores(),
            max_participants_per_room: default_max_participants_per_room(),
            empty_room_timeout_secs: default_empty_room_timeout_secs(),
            udp_port_range_start: default_udp_port_range_start(),
            udp_port_range_end: default_udp_port_range_end(),
            ice: IceConfig::default(),
            audio: AudioConfig::default(),
            video: VideoConfig::default(),
            bandwidth: BandwidthConfig::default(),
        }
    }
}

fn default_dedicated_cores() -> usize {
    2
}
fn default_max_participants_per_room() -> usize {
    25
}
fn default_empty_room_timeout_secs() -> u64 {
    300
}
fn default_udp_port_range_start() -> u16 {
    10000
}
fn default_udp_port_range_end() -> u16 {
    10100
}

#[derive(Debug, Clone, Deserialize)]
pub struct IceConfig {
    #[serde(default)]
    pub turn_secret: String,
    #[serde(default)]
    pub turn_urls: Vec<String>,
    #[serde(default)]
    pub stun_urls: Vec<String>,
}

impl Default for IceConfig {
    fn default() -> Self {
        Self {
            turn_secret: String::new(),
            turn_urls: vec![],
            stun_urls: vec![],
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AudioConfig {
    #[serde(default = "default_audio_max_bitrate")]
    pub max_bitrate_kbps: u32,
    #[serde(default = "default_audio_preferred_bitrate")]
    pub preferred_bitrate_kbps: u32,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            max_bitrate_kbps: default_audio_max_bitrate(),
            preferred_bitrate_kbps: default_audio_preferred_bitrate(),
        }
    }
}

fn default_audio_max_bitrate() -> u32 {
    128
}
fn default_audio_preferred_bitrate() -> u32 {
    64
}

#[derive(Debug, Clone, Deserialize)]
pub struct VideoConfig {
    #[serde(default = "default_video_max_bitrate")]
    pub max_bitrate_kbps: u32,
    #[serde(default = "default_video_max_resolution")]
    pub max_resolution: String,
    #[serde(default = "default_video_max_framerate")]
    pub max_framerate: u32,
}

impl Default for VideoConfig {
    fn default() -> Self {
        Self {
            max_bitrate_kbps: default_video_max_bitrate(),
            max_resolution: default_video_max_resolution(),
            max_framerate: default_video_max_framerate(),
        }
    }
}

fn default_video_max_bitrate() -> u32 {
    2500
}
fn default_video_max_resolution() -> String {
    "1280x720".to_string()
}
fn default_video_max_framerate() -> u32 {
    30
}

#[derive(Debug, Clone, Deserialize)]
pub struct BandwidthConfig {
    #[serde(default = "default_total_mbps")]
    pub total_mbps: u32,
    #[serde(default = "default_per_user_kbps")]
    pub per_user_kbps: u32,
}

impl Default for BandwidthConfig {
    fn default() -> Self {
        Self {
            total_mbps: default_total_mbps(),
            per_user_kbps: default_per_user_kbps(),
        }
    }
}

fn default_total_mbps() -> u32 {
    100
}
fn default_per_user_kbps() -> u32 {
    4000
}
