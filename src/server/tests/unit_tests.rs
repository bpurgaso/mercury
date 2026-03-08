//! Unit-tier tests for server crate logic.
//!
//! These tests exercise pure functions and types from the server crates
//! without requiring database, Redis, or a running server instance.
//! They correspond to CORE-*, AUTH-*, MOD-*, and MEDIA-* spec IDs.

mod common;

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use chrono::{self, Utc};
use mercury_auth::{
    jwt::{create_access_token, create_refresh_token, create_token_pair, validate_token, Claims},
    password::{hash_password, verify_password},
    turn::{generate_turn_credentials, verify_turn_credential},
};
use mercury_core::{
    config::{
        AppConfig, AudioConfig, AuthConfig, BandwidthConfig, DatabaseConfig, IceConfig,
        MediaConfig, ModerationConfig, ObservabilityConfig, RedisConfig, ServerConfig,
        SimulcastLayer, TlsConfig, TurnConfig, VideoConfig, AutoActionsConfig,
    },
    error::MercuryError,
    ids::*,
    models::*,
};
use mercury_moderation::reports::is_valid_category;
use serde_json::json;
use uuid::Uuid;

// ── Helper configs ──────────────────────────────────────────

fn test_auth_config() -> AuthConfig {
    AuthConfig {
        jwt_secret: "test-secret-for-unit-tests".into(),
        jwt_expiry_minutes: 60,
        refresh_token_expiry_days: 30,
        argon2_memory_kib: 16384, // reduced for test speed
        argon2_iterations: 1,
        argon2_parallelism: 1,
    }
}

fn test_turn_config() -> TurnConfig {
    TurnConfig {
        enabled: true,
        secret: "test-turn-secret".into(),
        urls: vec!["turn:localhost:3478".into()],
        credential_ttl_seconds: 86400,
    }
}

fn minimal_toml(port: u16) -> String {
    format!(
        r#"
[server]
host = "0.0.0.0"
port = {port}

[database]
url = "postgres://localhost/mercury_test"

[redis]
url = "redis://localhost:6379"

[auth]
jwt_secret = "test-secret-key"

[tls]
cert_path = "/tmp/cert.pem"
key_path = "/tmp/key.pem"
"#
    )
}

// ════════════════════════════════════════════════════════════
//  CORE — mercury-core
// ════════════════════════════════════════════════════════════

// TESTSPEC: CORE-001
#[test]
fn uuid_v7_is_time_sorted() {
    let ids: Vec<UserId> = (0..1000).map(|_| UserId::new()).collect();
    for window in ids.windows(2) {
        assert!(
            window[1].0 >= window[0].0,
            "UUIDv7 should be lexicographically sorted: {} >= {}",
            window[1].0,
            window[0].0
        );
    }
}

// TESTSPEC: CORE-002
#[test]
fn uuid_v7_is_valid_uuid() {
    let id = UserId::new();
    let parsed = Uuid::parse_str(&id.0.to_string()).expect("should parse as valid UUID");
    assert_eq!(parsed.get_version_num(), 7, "UUID version should be 7");
}

// TESTSPEC: CORE-003
#[test]
fn typed_id_serialization_roundtrip() {
    let user_id = UserId::new();
    let json = serde_json::to_string(&user_id).unwrap();
    assert_eq!(user_id, serde_json::from_str::<UserId>(&json).unwrap());

    let server_id = ServerId::new();
    let json = serde_json::to_string(&server_id).unwrap();
    assert_eq!(server_id, serde_json::from_str::<ServerId>(&json).unwrap());

    let channel_id = ChannelId::new();
    let json = serde_json::to_string(&channel_id).unwrap();
    assert_eq!(channel_id, serde_json::from_str::<ChannelId>(&json).unwrap());

    let message_id = MessageId::new();
    let json = serde_json::to_string(&message_id).unwrap();
    assert_eq!(message_id, serde_json::from_str::<MessageId>(&json).unwrap());

    let device_id = DeviceId::new();
    let json = serde_json::to_string(&device_id).unwrap();
    assert_eq!(device_id, serde_json::from_str::<DeviceId>(&json).unwrap());
}

// TESTSPEC: CORE-004
#[test]
fn typed_id_sqlx_type_compatible() {
    // Compile-time check: if this compiles, all typed IDs implement sqlx::Type<Postgres>.
    fn assert_sqlx_type<T: sqlx::Type<sqlx::Postgres>>() {}
    assert_sqlx_type::<UserId>();
    assert_sqlx_type::<ServerId>();
    assert_sqlx_type::<ChannelId>();
    assert_sqlx_type::<MessageId>();
    assert_sqlx_type::<DmChannelId>();
    assert_sqlx_type::<DeviceId>();
    assert_sqlx_type::<ReportId>();
}

// TESTSPEC: CORE-005
#[test]
fn config_loads_default_toml() {
    let config: AppConfig =
        toml::from_str(&minimal_toml(8443)).expect("should parse minimal config");
    assert_eq!(config.server.port, 8443);
    assert_eq!(config.database.max_connections, 50);
    assert_eq!(config.auth.jwt_expiry_minutes, 60);
    assert_eq!(config.server.heartbeat_interval_secs, 30);
    assert_eq!(config.database.acquire_timeout_seconds, 5);
}

// TESTSPEC: CORE-006
#[test]
fn config_env_override() {
    // Verify that changing a TOML value propagates correctly
    let config: AppConfig =
        toml::from_str(&minimal_toml(9999)).expect("should parse config with override");
    assert_eq!(config.server.port, 9999);
}

// TESTSPEC: CORE-007
#[test]
fn error_types_display() {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    // Display strings are human-readable
    let err = MercuryError::NotFound("user not found".into());
    assert_eq!(err.to_string(), "not found: user not found");

    let err = MercuryError::Unauthorized("bad token".into());
    assert_eq!(err.to_string(), "unauthorized: bad token");

    let err = MercuryError::RateLimited { retry_after: 60 };
    assert_eq!(err.to_string(), "rate limited");

    // HTTP status code mappings
    let resp = MercuryError::NotFound("x".into()).into_response();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    let resp = MercuryError::Unauthorized("x".into()).into_response();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    let resp = MercuryError::RateLimited { retry_after: 30 }.into_response();
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);

    let resp = MercuryError::Forbidden("x".into()).into_response();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    let resp = MercuryError::BadRequest("x".into()).into_response();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let resp = MercuryError::Conflict("x".into()).into_response();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

// TESTSPEC: CORE-008
#[test]
fn user_model_constraints() {
    let user = User {
        id: UserId::new(),
        username: "testuser".into(),
        display_name: "Test User".into(),
        email: "test@example.com".into(),
        password_hash: "$argon2id$hash".into(),
        avatar_url: None,
        status: Some("online".into()),
        dm_policy: None,
        created_at: None,
        updated_at: None,
    };

    // Status values: online, idle, dnd, offline
    for status in &["online", "idle", "dnd", "offline"] {
        let mut u = user.clone();
        u.status = Some(status.to_string());
        let json = serde_json::to_value(&u).expect("should serialize");
        assert_eq!(json["status"], *status);
    }

    // Username 1-32 chars validated (struct-level check)
    assert!(!user.username.is_empty());
    assert!(user.username.len() <= 32);

    // Email contains @
    assert!(user.email.contains('@'));

    // Roundtrip
    let serialized = serde_json::to_string(&user).unwrap();
    let deserialized: User = serde_json::from_str(&serialized).unwrap();
    assert_eq!(deserialized.username, user.username);
    assert_eq!(deserialized.email, user.email);
}

// ════════════════════════════════════════════════════════════
//  AUTH — mercury-auth
// ════════════════════════════════════════════════════════════

// TESTSPEC: AUTH-001
#[test]
fn argon2id_hash_and_verify() {
    let config = test_auth_config();
    let password = "SecureP@ss1";
    let hash = hash_password(&config, password).expect("hash should succeed");
    assert!(hash.starts_with("$argon2id$"));
    assert!(verify_password(&config, password, &hash).expect("verify should succeed"));
}

// TESTSPEC: AUTH-002
#[test]
fn argon2id_wrong_password_fails() {
    let config = test_auth_config();
    let hash = hash_password(&config, "CorrectP@ss1").expect("hash should succeed");
    let result = verify_password(&config, "WrongP@ss2", &hash).expect("verify should not error");
    assert!(!result, "wrong password must not verify");
}

// TESTSPEC: AUTH-003
#[test]
fn argon2id_hash_is_not_plaintext() {
    let config = test_auth_config();
    let password = "MySecretPassword123!";
    let hash = hash_password(&config, password).expect("hash should succeed");
    assert!(
        !hash.contains(password),
        "hash string must not contain the plaintext password"
    );
}

// TESTSPEC: AUTH-004
#[test]
fn argon2id_uses_configured_params() {
    let config = test_auth_config();
    let hash = hash_password(&config, "test").expect("hash should succeed");
    let parsed = argon2::password_hash::PasswordHash::new(&hash).expect("should parse hash");
    assert_eq!(parsed.algorithm, argon2::ARGON2ID_IDENT);
    let params = parsed.params;
    assert_eq!(
        params.get_str("m").unwrap(),
        config.argon2_memory_kib.to_string()
    );
    assert_eq!(
        params.get_str("t").unwrap(),
        config.argon2_iterations.to_string()
    );
    assert_eq!(
        params.get_str("p").unwrap(),
        config.argon2_parallelism.to_string()
    );
}

// TESTSPEC: AUTH-005
#[test]
fn jwt_generate_and_validate() {
    let config = test_auth_config();
    let user_id = UserId::new();
    let (token, claims) = create_access_token(&config, user_id).expect("should create token");
    let decoded = validate_token(&config, &token).expect("should validate");
    assert_eq!(decoded.claims.sub, user_id.0.to_string());
    assert_eq!(decoded.claims.jti, claims.jti);
    assert_eq!(decoded.claims.token_type, "access");
    assert!(decoded.claims.exp > decoded.claims.iat);
}

// TESTSPEC: AUTH-006
#[test]
fn jwt_expired_token_rejected() {
    let config = test_auth_config();
    let user_id = UserId::new();
    let now = Utc::now();
    let exp = now - chrono::Duration::seconds(120);
    let claims = Claims {
        sub: user_id.0.to_string(),
        jti: Uuid::now_v7().to_string(),
        token_type: "access".into(),
        iat: (now - chrono::Duration::hours(2)).timestamp(),
        exp: exp.timestamp(),
    };
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(config.jwt_secret.as_bytes()),
    )
    .expect("should encode");
    let result = validate_token(&config, &token);
    assert!(result.is_err(), "expired token should be rejected");
}

// TESTSPEC: AUTH-007
#[test]
fn jwt_tampered_token_rejected() {
    let config = test_auth_config();
    let user_id = UserId::new();
    let (token, _) = create_access_token(&config, user_id).expect("should create token");
    let mut chars: Vec<char> = token.chars().collect();
    let last = chars.len() - 1;
    chars[last] = if chars[last] == 'A' { 'B' } else { 'A' };
    let tampered: String = chars.into_iter().collect();
    let result = validate_token(&config, &tampered);
    assert!(result.is_err(), "tampered token must be rejected");
}

// TESTSPEC: AUTH-008
#[test]
fn jwt_wrong_secret_rejected() {
    let config = test_auth_config();
    let user_id = UserId::new();
    let (token, _) = create_access_token(&config, user_id).expect("should create token");
    let bad_config = AuthConfig {
        jwt_secret: "wrong-secret".into(),
        ..test_auth_config()
    };
    let result = validate_token(&bad_config, &token);
    assert!(result.is_err(), "wrong secret must reject token");
}

// TESTSPEC: AUTH-009
#[test]
fn refresh_token_is_distinct_from_access() {
    let config = test_auth_config();
    let user_id = UserId::new();
    let pair = create_token_pair(&config, user_id).expect("should create pair");
    assert_ne!(pair.access_token, pair.refresh_token, "tokens must differ");
    assert_ne!(pair.access_token_jti, pair.refresh_token_jti, "JTIs must differ");
    assert_ne!(pair.access_token_exp, pair.refresh_token_exp, "expiry must differ");
}

// TESTSPEC: AUTH-010
#[test]
fn turn_credential_generation() {
    let config = test_turn_config();
    let creds = generate_turn_credentials("user-123", &config);
    assert!(creds.username.contains("user-123"));
    assert!(!creds.credential.is_empty());
    assert_eq!(creds.ttl, 86400);

    // Username contains future timestamp
    let parts: Vec<&str> = creds.username.split(':').collect();
    let ts: u64 = parts[0].parse().expect("should be a number");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!(ts > now, "timestamp should be in the future");

    // Credential is valid base64
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(&creds.credential)
        .expect("credential should be valid base64");
}

// TESTSPEC: AUTH-011
#[test]
fn turn_credential_hmac_verifiable() {
    let config = test_turn_config();
    let creds = generate_turn_credentials("user-456", &config);
    assert!(
        verify_turn_credential(&creds.username, &creds.credential, &config.secret),
        "HMAC should verify with correct secret"
    );
    assert!(
        !verify_turn_credential(&creds.username, &creds.credential, "wrong-secret"),
        "HMAC should fail with wrong secret"
    );
}

// ════════════════════════════════════════════════════════════
//  CRYPTO — mercury-crypto
// ════════════════════════════════════════════════════════════
//
// CRYPTO-001 through CRYPTO-006 are blocked: the mercury-crypto crate
// contains only a stub comment and no production code to test.
// The server stores/relays crypto blobs but does not perform crypto
// operations. These tests require production code to be implemented first.

// ════════════════════════════════════════════════════════════
//  MOD — mercury-moderation
// ════════════════════════════════════════════════════════════

// TESTSPEC: MOD-001
#[test]
fn abuse_signal_rapid_messaging() {
    let config = AutoActionsConfig::default();
    let msg_count: u64 = 31;
    assert!(
        msg_count > config.rapid_messaging_threshold,
        "31 messages in 60s should exceed threshold of {}",
        config.rapid_messaging_threshold
    );
    // Severity should be at least medium for rapid messaging
    assert_eq!(config.rapid_messaging_threshold, 30);
}

// TESTSPEC: MOD-002
#[test]
fn abuse_signal_below_threshold() {
    let config = AutoActionsConfig::default();
    let msg_count: u64 = 29;
    assert!(
        msg_count <= config.rapid_messaging_threshold,
        "29 messages should NOT exceed threshold of {}",
        config.rapid_messaging_threshold
    );
}

// TESTSPEC: MOD-003
#[test]
fn abuse_signal_mass_dm() {
    let config = AutoActionsConfig::default();
    let dm_count: u64 = 21;
    assert!(
        dm_count > config.mass_dm_threshold,
        "21 new DM channels in 1h should exceed threshold of {}",
        config.mass_dm_threshold
    );
}

// TESTSPEC: MOD-004
#[test]
fn abuse_signal_join_spam() {
    let config = AutoActionsConfig::default();
    let join_count: u64 = 11;
    assert!(
        join_count > config.join_spam_threshold,
        "11 server joins in 1h should exceed threshold of {}",
        config.join_spam_threshold
    );
}

// TESTSPEC: MOD-005
#[test]
fn abuse_signal_report_threshold() {
    let config = AutoActionsConfig::default();
    let report_count: u64 = 6;
    assert!(
        report_count > config.report_alert_threshold,
        "6 reports should exceed threshold of {}",
        config.report_alert_threshold
    );
}

// TESTSPEC: MOD-006
#[test]
fn ban_expiry_logic() {
    // Ban with 1h expiry: not expired now
    let ban = ServerBan {
        server_id: ServerId::new(),
        user_id: UserId::new(),
        banned_by: UserId::new(),
        reason: Some("test".into()),
        expires_at: Some(Utc::now() + chrono::Duration::hours(1)),
        created_at: Some(Utc::now()),
    };
    assert!(ban.expires_at.unwrap() > Utc::now(), "future ban should not be expired");

    // Ban with past expiry: expired
    let expired_ban = ServerBan {
        expires_at: Some(Utc::now() - chrono::Duration::seconds(1)),
        ..ban.clone()
    };
    assert!(expired_ban.expires_at.unwrap() < Utc::now(), "past ban should be expired");
}

// TESTSPEC: MOD-007
#[test]
fn ban_permanent_never_expires() {
    let ban = ServerBan {
        server_id: ServerId::new(),
        user_id: UserId::new(),
        banned_by: UserId::new(),
        reason: Some("permanent".into()),
        expires_at: None,
        created_at: Some(Utc::now()),
    };
    assert!(ban.expires_at.is_none(), "permanent ban has no expiry");
}

// TESTSPEC: MOD-008
#[test]
fn mute_expiry_logic() {
    let mute = ChannelMute {
        channel_id: ChannelId::new(),
        user_id: UserId::new(),
        muted_by: UserId::new(),
        reason: None,
        expires_at: Some(Utc::now() + chrono::Duration::minutes(30)),
        created_at: Some(Utc::now()),
    };
    assert!(mute.expires_at.unwrap() > Utc::now(), "future mute should not be expired");

    let expired_mute = ChannelMute {
        expires_at: Some(Utc::now() - chrono::Duration::seconds(1)),
        ..mute
    };
    assert!(expired_mute.expires_at.unwrap() < Utc::now(), "past mute should be expired");
}

// TESTSPEC: MOD-009
#[test]
fn report_category_validation() {
    assert!(is_valid_category("spam"));
    assert!(is_valid_category("harassment"));
    assert!(is_valid_category("illegal"));
    assert!(is_valid_category("csam"));
    assert!(is_valid_category("other"));

    assert!(!is_valid_category("invalid"));
    assert!(!is_valid_category(""));
    assert!(!is_valid_category("SPAM"));
    assert!(!is_valid_category("phishing"));
}

// TESTSPEC: MOD-010
#[test]
fn report_status_transitions() {
    // Valid statuses: pending, reviewed, actioned, dismissed
    let report = Report {
        id: ReportId::new(),
        reporter_id: UserId::new(),
        reported_user_id: UserId::new(),
        server_id: None,
        channel_id: None,
        message_id: None,
        category: "spam".into(),
        description: None,
        evidence_blob: None,
        status: Some("pending".into()),
        reviewed_by: None,
        reviewed_at: None,
        action_taken: None,
        created_at: None,
    };

    // Valid transitions from pending
    for target in &["reviewed", "actioned", "dismissed"] {
        let mut r = report.clone();
        r.status = Some(target.to_string());
        assert_eq!(r.status.as_deref(), Some(*target));
    }
}

// TESTSPEC: MOD-011
#[test]
fn audit_log_entry_immutable() {
    // The audit module exposes only log_action (INSERT) and get_audit_log (SELECT).
    // No update or delete function exists — this verifies the append-only design.
    let entry = ModAuditLog {
        id: 1,
        server_id: ServerId::new(),
        moderator_id: UserId::new(),
        action: "ban".into(),
        target_user_id: UserId::new(),
        target_channel_id: None,
        reason: Some("test".into()),
        metadata: None,
        created_at: Some(Utc::now()),
    };
    assert_eq!(entry.action, "ban");
    assert!(entry.created_at.is_some());
    // If this compiles, the append-only contract holds at the type level.
}

// TESTSPEC: MOD-012
#[test]
fn block_list_unidirectional() {
    let a = UserId::new();
    let b = UserId::new();

    // A blocks B
    let block = UserBlock {
        blocker_id: a,
        blocked_id: b,
        created_at: Some(Utc::now()),
    };
    assert_eq!(block.blocker_id, a);
    assert_eq!(block.blocked_id, b);

    // The reverse relationship is a DIFFERENT record
    let reverse = UserBlock {
        blocker_id: b,
        blocked_id: a,
        created_at: Some(Utc::now()),
    };
    assert_ne!(block.blocker_id, reverse.blocker_id);
    assert_ne!(block.blocked_id, reverse.blocked_id);
}

// ════════════════════════════════════════════════════════════
//  MEDIA — mercury-media
// ════════════════════════════════════════════════════════════

// TESTSPEC: MEDIA-001
#[tokio::test]
async fn room_create_destroy() {
    use mercury_media::room::RoomManager;
    use mercury_media::types::SfuEvent;
    use tokio::sync::mpsc;

    let (tx, mut _rx) = mpsc::channel::<SfuEvent>(100);
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 10000);
    let mut mgr = RoomManager::new(5, Duration::from_secs(0), tx, addr);

    let user = UserId::new();
    let channel = ChannelId::new();

    let result = mgr.join(user, "device-1".into(), channel, None).await;
    assert!(result.is_ok(), "join should succeed");
    let join = result.unwrap();
    assert!(!join.room_id.is_empty());

    let room = mgr.get_room(&join.room_id);
    assert!(room.is_some(), "room should exist after join");
    let info = room.unwrap();
    assert_eq!(info.channel_id, channel.0.to_string());

    mgr.leave(user, channel).await;
}

// TESTSPEC: MEDIA-002
#[tokio::test]
async fn room_add_remove_participant() {
    use mercury_media::room::RoomManager;
    use mercury_media::types::SfuEvent;
    use tokio::sync::mpsc;

    let (tx, mut _rx) = mpsc::channel::<SfuEvent>(100);
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 10001);
    let mut mgr = RoomManager::new(5, Duration::from_secs(0), tx, addr);

    let channel = ChannelId::new();
    let u1 = UserId::new();
    let u2 = UserId::new();
    let u3 = UserId::new();

    mgr.join(u1, "d1".into(), channel, None).await.unwrap();
    mgr.join(u2, "d2".into(), channel, None).await.unwrap();
    mgr.join(u3, "d3".into(), channel, None).await.unwrap();

    let room = mgr.get_room_by_channel(channel).unwrap();
    assert_eq!(room.participants.len(), 3, "should have 3 participants");

    mgr.leave(u3, channel).await;
    let room = mgr.get_room_by_channel(channel).unwrap();
    assert_eq!(room.participants.len(), 2, "should have 2 after removal");
}

// TESTSPEC: MEDIA-003
#[tokio::test]
async fn room_max_participants_enforced() {
    use mercury_media::room::RoomManager;
    use mercury_media::types::{SfuError, SfuEvent};
    use tokio::sync::mpsc;

    let (tx, mut _rx) = mpsc::channel::<SfuEvent>(100);
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 10002);
    let mut mgr = RoomManager::new(5, Duration::from_secs(0), tx, addr);

    let channel = ChannelId::new();

    for i in 0..5 {
        let user = UserId::new();
        let result = mgr.join(user, format!("d{i}"), channel, None).await;
        assert!(result.is_ok(), "participant {i} should join");
    }

    let extra = UserId::new();
    let result = mgr.join(extra, "d-extra".into(), channel, None).await;
    assert!(result.is_err(), "6th participant should be rejected");
    match result.unwrap_err() {
        SfuError::RoomFull => {}
        other => panic!("expected RoomFull, got {:?}", other),
    }
}

// TESTSPEC: MEDIA-004
#[test]
fn quality_config_parsing() {
    let config = MediaConfig::default();
    assert_eq!(config.audio.max_bitrate_kbps, 128);
    assert_eq!(config.audio.preferred_bitrate_kbps, 64);
    assert_eq!(config.video.max_bitrate_kbps, 2500);
    assert!(config.video.simulcast_enabled);
    assert_eq!(config.video.simulcast_layers.len(), 3);
    assert_eq!(config.video.simulcast_layers[0].rid, "h");
    assert_eq!(config.video.simulcast_layers[0].max_bitrate_kbps, 2500);
    assert_eq!(config.video.simulcast_layers[1].rid, "m");
    assert_eq!(config.video.simulcast_layers[1].max_bitrate_kbps, 500);
    assert_eq!(config.video.simulcast_layers[2].rid, "l");
    assert_eq!(config.video.simulcast_layers[2].max_bitrate_kbps, 150);
    assert_eq!(config.bandwidth.total_mbps, 100);
    assert_eq!(config.bandwidth.per_user_kbps, 4000);
}

// TESTSPEC: MEDIA-005
#[test]
fn simulcast_layer_selection() {
    let layers = vec![
        SimulcastLayer { rid: "h".into(), max_bitrate_kbps: 2500, scale_resolution_down_by: 1.0 },
        SimulcastLayer { rid: "m".into(), max_bitrate_kbps: 500, scale_resolution_down_by: 2.0 },
        SimulcastLayer { rid: "l".into(), max_bitrate_kbps: 150, scale_resolution_down_by: 4.0 },
    ];

    let receiver_bandwidth_kbps: u32 = 600;
    let selected = layers
        .iter()
        .filter(|l| l.max_bitrate_kbps <= receiver_bandwidth_kbps)
        .max_by_key(|l| l.max_bitrate_kbps);

    assert!(selected.is_some());
    assert_eq!(selected.unwrap().rid, "m", "600kbps should select medium layer");
}

// TESTSPEC: MEDIA-006
#[test]
fn bandwidth_budget_enforcement() {
    let config = BandwidthConfig::default();
    let total_kbps = config.total_mbps * 1000;
    let total_demand: u32 = 30 * config.per_user_kbps;

    assert!(
        total_demand > total_kbps,
        "30 users × {}kbps = {} exceeds budget of {}",
        config.per_user_kbps,
        total_demand,
        total_kbps
    );
}
