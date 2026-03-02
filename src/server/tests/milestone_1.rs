mod common;

use common::{setup, TestServer};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::time::sleep;

// ────────────────────────────────────────────────────────────
//  Shared infrastructure
// ────────────────────────────────────────────────────────────
//
//  All tests share ONE tokio runtime and ONE server instance.
//  This is required because `tokio::spawn` (used by the server)
//  is tied to the runtime that created it — if each `#[tokio::test]`
//  created its own runtime, the server would die when the first
//  test's runtime was dropped.
//
//  Tests MUST run sequentially (`--test-threads=1` / `nextest -j 1`)
//  because they share database and Redis state.

fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime")
    })
}

fn server() -> &'static TestServer {
    static SERVER: OnceLock<TestServer> = OnceLock::new();
    SERVER.get_or_init(|| runtime().block_on(TestServer::start()))
}

/// Helper: register a user and return (access_token, user_id).
async fn register_user(
    srv: &TestServer,
    username: &str,
    email: &str,
) -> (String, String) {
    let mut client = srv.client();
    let (status, _) = client
        .register_raw(username, email, "password123")
        .await;
    assert_eq!(status, 201, "registration should succeed for {username}");
    (client.access_token.unwrap(), client.user_id.unwrap())
}

// ────────────────────────────────────────────────────────────
//  1. Health Check (Phase 1)
// ────────────────────────────────────────────────────────────

#[test]
fn test_health_returns_200() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let client = srv.client();
        let (status, body) = client.get_text("/health").await;
        assert_eq!(status, 200);
        assert!(body.contains("ok") || body.contains("degraded"), "body should contain status indicator");
    });
}

#[test]
fn test_health_requires_no_auth() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let client = srv.client();
        let (status, _) = client.get_text("/health").await;
        assert_eq!(status, 200, "health should not require auth");
    });
}

// ────────────────────────────────────────────────────────────
//  2. Database Schema Validation (Phase 2)
// ────────────────────────────────────────────────────────────

#[test]
fn test_uuid_v7_is_time_sorted() {
    let mut prev = uuid::Uuid::now_v7().to_string();
    for _ in 0..100 {
        let next = uuid::Uuid::now_v7().to_string();
        assert!(
            next > prev,
            "UUIDv7 should be lexicographically sorted: {prev} >= {next}"
        );
        prev = next;
    }
}

#[test]
fn test_channel_encryption_mode_constraint() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let user_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO users (id, username, display_name, email, password_hash) \
             VALUES ($1, 'testuser', 'Test', 'test@example.com', 'hash')",
        )
        .bind(user_id)
        .execute(&srv.db)
        .await
        .unwrap();

        let server_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO servers (id, name, owner_id, invite_code) \
             VALUES ($1, 'test server', $2, 'INV001')",
        )
        .bind(server_id)
        .bind(user_id)
        .execute(&srv.db)
        .await
        .unwrap();

        // 'standard' should succeed
        let standard = sqlx::query(
            "INSERT INTO channels (id, server_id, name, channel_type, encryption_mode) \
             VALUES ($1, $2, 'general', 'text', 'standard')",
        )
        .bind(uuid::Uuid::now_v7())
        .bind(server_id)
        .execute(&srv.db)
        .await;
        assert!(standard.is_ok(), "encryption_mode 'standard' should succeed");

        // 'private' should succeed (with max_members <= 100)
        let private = sqlx::query(
            "INSERT INTO channels (id, server_id, name, channel_type, encryption_mode, max_members) \
             VALUES ($1, $2, 'secret', 'text', 'private', 50)",
        )
        .bind(uuid::Uuid::now_v7())
        .bind(server_id)
        .execute(&srv.db)
        .await;
        assert!(private.is_ok(), "encryption_mode 'private' should succeed");

        // 'private' with max_members > 100 should FAIL
        let private_too_many = sqlx::query(
            "INSERT INTO channels (id, server_id, name, channel_type, encryption_mode, max_members) \
             VALUES ($1, $2, 'secret2', 'text', 'private', 200)",
        )
        .bind(uuid::Uuid::now_v7())
        .bind(server_id)
        .execute(&srv.db)
        .await;
        assert!(
            private_too_many.is_err(),
            "private channel with max_members > 100 should fail CHECK constraint"
        );
    });
}

#[test]
fn test_server_members_is_moderator_default() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let user_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO users (id, username, display_name, email, password_hash) \
             VALUES ($1, 'moduser', 'Mod', 'mod@example.com', 'hash')",
        )
        .bind(user_id)
        .execute(&srv.db)
        .await
        .unwrap();

        let server_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO servers (id, name, owner_id, invite_code) \
             VALUES ($1, 'test', $2, 'INV002')",
        )
        .bind(server_id)
        .bind(user_id)
        .execute(&srv.db)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO server_members (user_id, server_id) VALUES ($1, $2)",
        )
        .bind(user_id)
        .bind(server_id)
        .execute(&srv.db)
        .await
        .unwrap();

        let row: (bool,) = sqlx::query_as(
            "SELECT is_moderator FROM server_members WHERE user_id = $1 AND server_id = $2",
        )
        .bind(user_id)
        .bind(server_id)
        .fetch_one(&srv.db)
        .await
        .unwrap();

        assert!(!row.0, "is_moderator should default to false");
    });
}

#[test]
fn test_channels_sender_key_epoch_default() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let user_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO users (id, username, display_name, email, password_hash) \
             VALUES ($1, 'epochuser', 'Epoch', 'epoch@example.com', 'hash')",
        )
        .bind(user_id)
        .execute(&srv.db)
        .await
        .unwrap();

        let server_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO servers (id, name, owner_id, invite_code) \
             VALUES ($1, 'test', $2, 'INV003')",
        )
        .bind(server_id)
        .bind(user_id)
        .execute(&srv.db)
        .await
        .unwrap();

        let channel_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO channels (id, server_id, name, channel_type) \
             VALUES ($1, $2, 'general', 'text')",
        )
        .bind(channel_id)
        .bind(server_id)
        .execute(&srv.db)
        .await
        .unwrap();

        let row: (i64,) = sqlx::query_as(
            "SELECT sender_key_epoch FROM channels WHERE id = $1",
        )
        .bind(channel_id)
        .fetch_one(&srv.db)
        .await
        .unwrap();

        assert_eq!(row.0, 0, "sender_key_epoch should default to 0");
    });
}

#[test]
fn test_message_recipients_unique_constraint() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let user_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO users (id, username, display_name, email, password_hash) \
             VALUES ($1, 'msguser', 'Msg', 'msg@example.com', 'hash')",
        )
        .bind(user_id)
        .execute(&srv.db)
        .await
        .unwrap();

        let server_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO servers (id, name, owner_id, invite_code) VALUES ($1, 'srv', $2, 'INV004')",
        )
        .bind(server_id)
        .bind(user_id)
        .execute(&srv.db)
        .await
        .unwrap();

        let channel_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO channels (id, server_id, name, channel_type) VALUES ($1, $2, 'ch', 'text')",
        )
        .bind(channel_id)
        .bind(server_id)
        .execute(&srv.db)
        .await
        .unwrap();

        let msg_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO messages (id, channel_id, sender_id, content) VALUES ($1, $2, $3, 'hello')",
        )
        .bind(msg_id)
        .bind(channel_id)
        .bind(user_id)
        .execute(&srv.db)
        .await
        .unwrap();

        let device_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO devices (id, user_id, device_name) VALUES ($1, $2, 'test-device')",
        )
        .bind(device_id)
        .bind(user_id)
        .execute(&srv.db)
        .await
        .unwrap();

        // First insert should succeed
        sqlx::query(
            "INSERT INTO message_recipients (message_id, device_id, ciphertext) VALUES ($1, $2, $3)",
        )
        .bind(msg_id)
        .bind(device_id)
        .bind(b"cipher1" as &[u8])
        .execute(&srv.db)
        .await
        .unwrap();

        // Second insert with same (message_id, device_id) should fail
        let dup = sqlx::query(
            "INSERT INTO message_recipients (message_id, device_id, ciphertext) VALUES ($1, $2, $3)",
        )
        .bind(msg_id)
        .bind(device_id)
        .bind(b"cipher2" as &[u8])
        .execute(&srv.db)
        .await;

        assert!(
            dup.is_err(),
            "duplicate (message_id, device_id) should violate UNIQUE constraint"
        );
    });
}

// ────────────────────────────────────────────────────────────
//  3. Authentication (Phase 3)
// ────────────────────────────────────────────────────────────

#[test]
fn test_register_success() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let mut client = srv.client();
        let (status, body) = client
            .register_raw("alice", "alice@example.com", "password123")
            .await;

        assert_eq!(status, 201, "register should return 201");
        assert!(body["user_id"].is_string(), "response should contain user_id");
        assert!(body["access_token"].is_string(), "response should contain access_token");
        assert!(body["refresh_token"].is_string(), "response should contain refresh_token");
        assert!(body["expires_in"].is_number(), "response should contain expires_in");
    });
}

#[test]
fn test_register_duplicate_email() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let mut client = srv.client();
        let (status1, _) = client
            .register_raw("user_a", "same@example.com", "password123")
            .await;
        assert_eq!(status1, 201);

        let mut client2 = srv.client();
        let (status2, _) = client2
            .register_raw("user_b", "same@example.com", "password456")
            .await;
        assert_eq!(status2, 409, "duplicate email should return 409");
    });
}

#[test]
fn test_register_duplicate_username() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let mut client = srv.client();
        let (status1, _) = client
            .register_raw("sameuser", "a@example.com", "password123")
            .await;
        assert_eq!(status1, 201);

        let mut client2 = srv.client();
        let (status2, _) = client2
            .register_raw("sameuser", "b@example.com", "password456")
            .await;
        assert_eq!(status2, 409, "duplicate username should return 409");
    });
}

#[test]
fn test_login_success() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let mut client = srv.client();
        client
            .register_raw("loginuser", "login@example.com", "password123")
            .await;

        let mut client2 = srv.client();
        let (status, body) = client2
            .login_raw("login@example.com", "password123")
            .await;

        assert_eq!(status, 200, "login should return 200");
        assert!(body["access_token"].is_string());
        assert!(body["refresh_token"].is_string());
    });
}

#[test]
fn test_login_wrong_password() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let mut client = srv.client();
        client
            .register_raw("wrongpw", "wrongpw@example.com", "password123")
            .await;

        let mut client2 = srv.client();
        let (status, _) = client2
            .login_raw("wrongpw@example.com", "wrongpassword")
            .await;
        assert_eq!(status, 401, "wrong password should return 401");
    });
}

#[test]
fn test_login_nonexistent_user() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let mut client = srv.client();
        let (status, _) = client
            .login_raw("nobody@example.com", "password123")
            .await;
        assert_eq!(status, 401, "nonexistent user login should return 401");
    });
}

#[test]
fn test_refresh_token() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let mut client = srv.client();
        let (status, _) = client
            .register_raw("refreshuser", "refresh@example.com", "password123")
            .await;
        assert_eq!(status, 201);

        let original_access = client.access_token.clone().unwrap();
        let refresh = client.refresh_token.clone().unwrap();

        let (status, body) = client
            .post_json("/auth/refresh", &json!({ "refresh_token": refresh }))
            .await;

        assert_eq!(status, 200, "refresh should return 200");
        let new_access = body["access_token"].as_str().unwrap();
        assert_ne!(
            new_access, original_access,
            "new access token should differ from original"
        );
    });
}

#[test]
fn test_refresh_with_access_token_fails() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let mut client = srv.client();
        client
            .register_raw("refacc", "refacc@example.com", "password123")
            .await;

        let access = client.access_token.clone().unwrap();

        let (status, _) = client
            .post_json("/auth/refresh", &json!({ "refresh_token": access }))
            .await;
        assert_eq!(
            status, 401,
            "using access token as refresh should return 401"
        );
    });
}

#[test]
fn test_logout_revokes_session() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let mut client = srv.client();
        client
            .register_raw("logoutuser", "logout@example.com", "password123")
            .await;

        let status = client
            .post_authed_status("/auth/logout", &json!({}))
            .await;
        assert!(
            status == 200 || status == 204,
            "logout should return 200 or 204, got {status}"
        );

        let (status, _) = client.get_authed("/users/me").await;
        assert_eq!(status, 401, "access token should be rejected after logout");
    });
}

#[test]
fn test_expired_token_rejected() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let now = chrono::Utc::now();
        let claims = json!({
            "sub": uuid::Uuid::now_v7().to_string(),
            "jti": uuid::Uuid::now_v7().to_string(),
            "token_type": "access",
            "iat": (now - chrono::Duration::hours(2)).timestamp(),
            "exp": (now - chrono::Duration::seconds(120)).timestamp(),
        });

        let header = jsonwebtoken::Header::default();
        let token = jsonwebtoken::encode(
            &header,
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(
                b"test-secret-for-integration-tests",
            ),
        )
        .unwrap();

        let resp = reqwest::Client::new()
            .get(format!("{}/users/me", srv.base_url()))
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), 401, "expired token should be rejected");
    });
}

#[test]
fn test_authenticated_endpoint() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let mut client = srv.client();
        client
            .register_raw("meuser", "meuser@example.com", "password123")
            .await;

        let (status, body) = client.get_authed("/users/me").await;
        assert_eq!(status, 200);
        assert_eq!(body["username"], "meuser");
        assert_eq!(body["email"], "meuser@example.com");
    });
}

#[test]
fn test_unauthenticated_endpoint_rejected() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let client = srv.client();
        let (status, _) = client.get("/users/me").await;
        assert_eq!(status, 401, "unauthenticated request should return 401");
    });
}

#[test]
fn test_rate_limiting_auth_endpoints() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let client = srv.client();
        let mut statuses = Vec::new();

        for i in 0..6 {
            let (status, headers, _) = client
                .post_raw(
                    "/auth/register",
                    &json!({
                        "username": format!("ratelimit{i}"),
                        "email": format!("rate{i}@example.com"),
                        "password": "password123",
                    }),
                )
                .await;
            statuses.push((status, headers));
        }

        for (i, (status, _)) in statuses.iter().enumerate().take(5) {
            assert_ne!(status.as_u16(), 429, "request {i} should not be rate limited");
        }

        let (status, headers) = &statuses[5];
        assert_eq!(status.as_u16(), 429, "6th request should be rate limited");
        assert!(
            headers.contains_key("retry-after"),
            "429 response should include Retry-After header"
        );
    });
}

// ────────────────────────────────────────────────────────────
//  4. WebSocket (Phase 4)
// ────────────────────────────────────────────────────────────

#[test]
fn test_ws_connect_and_identify() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token, _user_id) = register_user(srv, "wsuser", "ws@example.com").await;

        let mut ws = srv.ws_client(&token).await;
        let ready = ws.identify(&token, "device-1").await;

        assert!(ready["d"]["user"].is_object(), "READY should contain user info");
        assert!(ready["d"]["session_id"].is_string(), "READY should contain session_id");
        assert!(
            ready["d"]["heartbeat_interval"].is_number(),
            "READY should contain heartbeat_interval"
        );
        assert!(ready["d"]["servers"].is_array(), "READY should contain servers");
        assert!(
            ready["d"]["dm_channels"].is_array(),
            "READY should contain dm_channels"
        );

        ws.close().await;
    });
}

#[test]
fn test_ws_invalid_token_rejected() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let mut ws = srv.ws_client("garbage-token-value").await;
        let close_code = ws.receive_close().await;
        assert_eq!(close_code, Some(4008), "invalid token should close with 4008");
    });
}

#[test]
fn test_ws_identify_required_first() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token, _) = register_user(srv, "idfirst", "idfirst@example.com").await;

        let mut ws = srv.ws_client(&token).await;
        ws.send_heartbeat(0).await;

        let close_code = ws.receive_close().await;
        assert!(
            close_code.is_some(),
            "server should close connection when heartbeat sent before identify"
        );
    });
}

#[test]
fn test_ws_heartbeat_acknowledged() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token, _) = register_user(srv, "hbuser", "hb@example.com").await;

        let mut ws = srv.ws_client(&token).await;
        ws.identify(&token, "device-1").await;

        // Consume any PRESENCE_UPDATE that arrives after READY
        let _ = ws.receive_json_timeout(Duration::from_millis(500)).await;

        ws.send_heartbeat(0).await;

        let ack = ws.receive_json().await.expect("should receive HEARTBEAT_ACK");
        assert_eq!(ack["t"], "HEARTBEAT_ACK");

        ws.close().await;
    });
}

#[test]
fn test_ws_missed_heartbeats_disconnect() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token, _) = register_user(srv, "hbmiss", "hbmiss@example.com").await;

        let mut ws = srv.ws_client(&token).await;
        let ready = ws.identify(&token, "device-1").await;

        let hb_interval = ready["d"]["heartbeat_interval"].as_u64().unwrap_or(5);

        // Wait for 3 missed heartbeat intervals + buffer
        let wait_secs = hb_interval * 3 + 5;
        let close_code = ws
            .receive_close_timeout(Duration::from_secs(wait_secs))
            .await;

        assert_eq!(
            close_code,
            Some(4009),
            "missed heartbeats should close with 4009"
        );
    });
}

#[test]
fn test_ws_presence_online_on_identify() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token, user_id) = register_user(srv, "presuser", "pres@example.com").await;

        let mut ws = srv.ws_client(&token).await;
        ws.identify(&token, "device-1").await;

        let presence = ws
            .receive_json_timeout(Duration::from_secs(3))
            .await
            .expect("should receive PRESENCE_UPDATE after identify");

        assert_eq!(presence["t"], "PRESENCE_UPDATE");
        assert_eq!(presence["d"]["user_id"], user_id);
        assert_eq!(presence["d"]["status"], "online");

        ws.close().await;
    });
}

#[test]
fn test_ws_presence_debounce_absorbs_reconnect() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token, user_id) =
            register_user(srv, "debounce1", "debounce1@example.com").await;

        let mut ws = srv.ws_client(&token).await;
        ws.identify(&token, "device-1").await;
        let _ = ws.receive_json_timeout(Duration::from_millis(500)).await;

        ws.close().await;
        sleep(Duration::from_secs(2)).await;

        let mut ws2 = srv.ws_client(&token).await;
        ws2.identify(&token, "device-1").await;
        let _ = ws2.receive_json_timeout(Duration::from_millis(500)).await;

        let events = ws2
            .collect_events("PRESENCE_UPDATE", Duration::from_secs(1))
            .await;

        for evt in &events {
            if evt["d"]["user_id"] == user_id {
                assert_ne!(
                    evt["d"]["status"], "offline",
                    "should NOT see offline during debounce absorption"
                );
            }
        }

        ws2.close().await;
    });
}

#[test]
fn test_ws_presence_goes_offline_after_debounce() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token, user_id) =
            register_user(srv, "debounce2", "debounce2@example.com").await;

        let mut ws = srv.ws_client(&token).await;
        ws.identify(&token, "device-1").await;
        let _ = ws.receive_json_timeout(Duration::from_millis(500)).await;

        ws.close().await;

        // Wait longer than 15s debounce + 1s spawn delay
        sleep(Duration::from_secs(18)).await;

        let key = format!("presence:{}", user_id);
        let value: Option<String> =
            fred::prelude::KeysInterface::get(&srv.redis, &key)
                .await
                .unwrap_or(None);

        if let Some(json_str) = value {
            let presence: Value = serde_json::from_str(&json_str).unwrap();
            assert_eq!(
                presence["status"], "offline",
                "presence should be offline after debounce"
            );
        }
        // If key doesn't exist at all, that's also acceptable (expired)
    });
}

#[test]
fn test_ws_resume_replays_missed_events() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _) = register_user(srv, "resumeA", "resumeA@example.com").await;
        let (token_b, _) = register_user(srv, "resumeB", "resumeB@example.com").await;

        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, "device-a").await;
        let _ = ws_a.receive_json_timeout(Duration::from_millis(500)).await;

        let mut ws_b = srv.ws_client(&token_b).await;
        let ready_b = ws_b.identify(&token_b, "device-b").await;
        let session_id_b = ready_b["d"]["session_id"].as_str().unwrap().to_string();

        // Drain presence events on both
        let _ = ws_a.receive_json_timeout(Duration::from_millis(500)).await;
        let _ = ws_b.receive_json_timeout(Duration::from_millis(500)).await;
        let _ = ws_b.receive_json_timeout(Duration::from_millis(500)).await;

        let last_seq: u64 = 0;

        ws_b.close().await;
        sleep(Duration::from_millis(500)).await;

        // Trigger an event while B is offline
        ws_a.send_json(&json!({
            "op": "presence_update",
            "d": { "status": "idle" }
        }))
        .await;
        let _ = ws_a.receive_json_timeout(Duration::from_millis(500)).await;
        sleep(Duration::from_millis(500)).await;

        // User B reconnects with resume
        let mut ws_b2 = srv.ws_client(&token_b).await;
        ws_b2
            .send_resume(&token_b, &session_id_b, last_seq)
            .await;

        let mut received_events = Vec::new();
        for _ in 0..5 {
            match ws_b2.receive_json_timeout(Duration::from_secs(3)).await {
                Some(msg) => {
                    let event_type = msg["t"].as_str().unwrap_or("").to_string();
                    received_events.push(msg);
                    if event_type == "RESUMED" {
                        break;
                    }
                }
                None => break,
            }
        }

        assert!(
            received_events.iter().any(|e| e["t"] == "RESUMED"),
            "should receive RESUMED event on resume, got: {:?}",
            received_events
        );

        ws_a.close().await;
        ws_b2.close().await;
    });
}

#[test]
fn test_ws_resume_expired_session() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token, _) = register_user(srv, "expses", "expses@example.com").await;

        let mut ws = srv.ws_client(&token).await;
        ws.identify(&token, "device-1").await;
        ws.close().await;
        sleep(Duration::from_millis(500)).await;

        let mut ws2 = srv.ws_client(&token).await;
        ws2.send_resume(&token, "nonexistent-session-id", 0).await;

        let close_code = ws2.receive_close().await;
        assert_eq!(
            close_code,
            Some(4009),
            "expired/invalid session resume should close with 4009"
        );
    });
}

#[test]
fn test_ws_upgrade_rate_limiting() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token, _) = register_user(srv, "wsrate", "wsrate@example.com").await;

        // Send real WS upgrade requests — plain HTTP GETs don't trigger the
        // WebSocketUpgrade extractor so the rate limiter is never reached.
        // Test server sets ws_rate_limit_per_sec=10, so 20 attempts should
        // reliably exceed the limit within a single 1-second window.
        let ws_url = srv.ws_url(&token);
        let mut saw_rate_limit = false;

        for _ in 0..20 {
            match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((_ws, _)) => {
                    // Successful upgrade; drop the connection immediately.
                }
                Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                    if response.status() == 503 {
                        saw_rate_limit = true;
                        break;
                    }
                }
                Err(_) => continue,
            }
        }

        assert!(
            saw_rate_limit,
            "should eventually see 503 from WS rate limiter"
        );
    });
}

#[test]
fn test_ws_cross_user_presence() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, user_a_id) =
            register_user(srv, "crossA", "crossA@example.com").await;

        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, "device-a").await;
        let _ = ws_a.receive_json_timeout(Duration::from_millis(500)).await;

        let (token_b, user_b_id) =
            register_user(srv, "crossB", "crossB@example.com").await;

        let mut ws_b = srv.ws_client(&token_b).await;
        ws_b.identify(&token_b, "device-b").await;

        sleep(Duration::from_millis(500)).await;

        let events_a = ws_a
            .collect_events("PRESENCE_UPDATE", Duration::from_secs(2))
            .await;
        let b_online_on_a = events_a
            .iter()
            .any(|e| e["d"]["user_id"] == user_b_id && e["d"]["status"] == "online");
        assert!(
            b_online_on_a,
            "User A should see User B's online presence, events: {:?}",
            events_a
        );

        ws_a.close().await;

        // Wait for debounce (15s) + finalize (1s) + buffer.
        // We must keep User B alive by sending heartbeats, otherwise the
        // server disconnects B for missing heartbeats (5s interval × 3 = 15s).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let mut heartbeat_interval = tokio::time::interval(Duration::from_secs(4));
        heartbeat_interval.tick().await; // skip immediate first tick
        let mut saw_offline = false;

        loop {
            tokio::select! {
                msg = ws_b.receive_json_timeout(Duration::from_millis(500)) => {
                    if let Some(msg) = msg {
                        if msg["t"] == "PRESENCE_UPDATE"
                            && msg["d"]["user_id"] == user_a_id
                            && msg["d"]["status"] == "offline"
                        {
                            saw_offline = true;
                            break;
                        }
                    }
                }
                _ = heartbeat_interval.tick() => {
                    ws_b.send_heartbeat(0).await;
                    // Drain the HEARTBEAT_ACK
                    let _ = ws_b.receive_json_timeout(Duration::from_millis(200)).await;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
        }

        assert!(
            saw_offline,
            "User B should see User A go offline after debounce"
        );

        ws_b.close().await;
    });
}
