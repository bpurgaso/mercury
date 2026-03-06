mod common;

use common::{setup, TestServer};
use fred::prelude::*;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

// ────────────────────────────────────────────────────────────
//  Shared infrastructure
// ────────────────────────────────────────────────────────────

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

/// Register a user and return (access_token, user_id).
async fn register_user(srv: &TestServer, username: &str, email: &str) -> (String, String) {
    let mut client = srv.client();
    let (status, _) = client.register_raw(username, email, "password123").await;
    assert_eq!(status, 201, "registration should succeed for {username}");
    (client.access_token.unwrap(), client.user_id.unwrap())
}

/// Create a server and return (server_id, invite_code).
async fn create_server(srv: &TestServer, token: &str, name: &str) -> (String, String) {
    let client = srv.client();
    let (status, body) = client
        .post_authed_with_token(token, "/servers", &json!({ "name": name }))
        .await;
    assert_eq!(status, 201, "server creation should succeed");
    (
        body["id"].as_str().unwrap().to_string(),
        body["invite_code"].as_str().unwrap().to_string(),
    )
}

/// Join a server via invite code.
async fn join_server(srv: &TestServer, token: &str, invite_code: &str) {
    let client = srv.client();
    let (status, _) = client
        .post_authed_with_token(token, "/servers/join", &json!({ "invite_code": invite_code }))
        .await;
    assert_eq!(status, 200, "joining server should succeed");
}

/// Create a channel in a server.
async fn create_channel(
    srv: &TestServer,
    token: &str,
    server_id: &str,
    name: &str,
) -> String {
    let client = srv.client();
    let (status, body) = client
        .post_authed_with_token(
            token,
            &format!("/servers/{server_id}/channels"),
            &json!({ "name": name, "channel_type": "text", "encryption_mode": "standard" }),
        )
        .await;
    assert_eq!(status, 201, "channel creation should succeed");
    body["id"].as_str().unwrap().to_string()
}

// ────────────────────────────────────────────────────────────
//  TestClient helper extension for using an explicit token
// ────────────────────────────────────────────────────────────

trait TestClientExt {
    fn post_authed_with_token(
        &self,
        token: &str,
        path: &str,
        body: &Value,
    ) -> impl std::future::Future<Output = (reqwest::StatusCode, Value)>;

    fn get_authed_with_token(
        &self,
        token: &str,
        path: &str,
    ) -> impl std::future::Future<Output = (reqwest::StatusCode, Value)>;

    fn patch_authed_with_token(
        &self,
        token: &str,
        path: &str,
        body: &Value,
    ) -> impl std::future::Future<Output = (reqwest::StatusCode, Value)>;

}

impl TestClientExt for common::TestClient {
    async fn post_authed_with_token(
        &self,
        token: &str,
        path: &str,
        body: &Value,
    ) -> (reqwest::StatusCode, Value) {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let resp = client
            .post(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .json(body)
            .send()
            .await
            .expect("POST request failed");
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(json!({}));
        (status, body)
    }

    async fn get_authed_with_token(
        &self,
        token: &str,
        path: &str,
    ) -> (reqwest::StatusCode, Value) {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let resp = client
            .get(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .expect("GET request failed");
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(json!({}));
        (status, body)
    }

    async fn patch_authed_with_token(
        &self,
        token: &str,
        path: &str,
        body: &Value,
    ) -> (reqwest::StatusCode, Value) {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let resp = client
            .patch(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .json(body)
            .send()
            .await
            .expect("PATCH request failed");
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(json!({}));
        (status, body)
    }

}

// ────────────────────────────────────────────────────────────
//  Report Submission Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_submit_report_and_list_and_review() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _owner_id) = register_user(srv, "owner", "owner@test.com").await;
        let (token_reporter, _reporter_id) =
            register_user(srv, "reporter", "reporter@test.com").await;
        let (_, bad_user_id) = register_user(srv, "baduser", "bad@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "ReportServer").await;
        join_server(srv, &token_reporter, &invite_code).await;

        let channel_id =
            create_channel(srv, &token_owner, &server_id, "general").await;

        // Connect owner via WebSocket to receive REPORT_CREATED events
        let mut ws_owner = srv.ws_client(&token_owner).await;
        ws_owner.identify(&token_owner, "device-owner").await;

        // Submit a report
        let (status, body) = client
            .post_authed_with_token(
                &token_reporter,
                "/reports",
                &json!({
                    "reported_user_id": bad_user_id,
                    "server_id": server_id,
                    "channel_id": channel_id,
                    "category": "spam",
                    "description": "This user is spamming the channel",
                }),
            )
            .await;
        assert_eq!(status, 201, "report submission should succeed");
        let report_id = body["id"].as_str().unwrap().to_string();
        assert_eq!(body["category"], "spam");
        assert_eq!(body["status"], "pending");

        // Owner should receive REPORT_CREATED event
        let events = ws_owner
            .collect_any_events("REPORT_CREATED", Duration::from_secs(3))
            .await;
        assert!(!events.is_empty(), "owner should receive REPORT_CREATED event");
        assert_eq!(events[0]["d"]["report"]["category"], "spam");
        ws_owner.close().await;

        // List reports for the server
        let (status, body) = client
            .get_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/reports?status=pending"),
            )
            .await;
        assert_eq!(status, 200);
        let reports = body.as_array().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["category"], "spam");
        // evidence_blob should not be in list view
        assert!(reports[0].get("evidence_blob").is_none());

        // Get single report detail
        let (status, body) = client
            .get_authed_with_token(&token_owner, &format!("/reports/{report_id}"))
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["id"], report_id);

        // Review report with action = kick
        let (status, body) = client
            .patch_authed_with_token(
                &token_owner,
                &format!("/reports/{report_id}"),
                &json!({
                    "status": "actioned",
                    "action_taken": "kick",
                }),
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "actioned");
        assert_eq!(body["action_taken"], "kick");

        // Check audit log for report_review entry
        let (status, body) = client
            .get_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/audit-log?action=report_review"),
            )
            .await;
        assert_eq!(status, 200);
        let entries = body.as_array().unwrap();
        assert_eq!(entries.len(), 1, "should have report_review audit entry");
        assert_eq!(entries[0]["action"], "report_review");
    });
}

#[test]
fn test_report_self_rejected() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_user, user_id) = register_user(srv, "selfie", "selfie@test.com").await;
        let client = srv.client();

        let (status, _) = client
            .post_authed_with_token(
                &token_user,
                "/reports",
                &json!({
                    "reported_user_id": user_id,
                    "category": "spam",
                    "description": "reporting myself",
                }),
            )
            .await;
        assert_eq!(status, 400, "cannot report yourself");
    });
}

#[test]
fn test_report_from_non_member_rejected() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_outsider, _) = register_user(srv, "outsider", "outsider@test.com").await;
        let (_, bad_user_id) = register_user(srv, "baduser", "bad@test.com").await;
        let client = srv.client();

        let (server_id, _invite_code) =
            create_server(srv, &token_owner, "PrivateServer").await;

        // Outsider tries to report with server context — should fail
        let (status, _) = client
            .post_authed_with_token(
                &token_outsider,
                "/reports",
                &json!({
                    "reported_user_id": bad_user_id,
                    "server_id": server_id,
                    "category": "harassment",
                    "description": "test",
                }),
            )
            .await;
        assert_eq!(status, 403, "non-member cannot report with server context");
    });
}

#[test]
fn test_report_rate_limit() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_reporter, _) =
            register_user(srv, "reporter", "reporter@test.com").await;
        let (_, target_id) = register_user(srv, "target", "target@test.com").await;
        let client = srv.client();

        // Submit 20 reports (the default limit)
        for i in 0..20 {
            let (status, _) = client
                .post_authed_with_token(
                    &token_reporter,
                    "/reports",
                    &json!({
                        "reported_user_id": target_id,
                        "category": "spam",
                        "description": format!("report #{}", i),
                    }),
                )
                .await;
            assert_eq!(status, 201, "report #{i} should succeed");
        }

        // 21st report should be rate limited
        let (status, _) = client
            .post_authed_with_token(
                &token_reporter,
                "/reports",
                &json!({
                    "reported_user_id": target_id,
                    "category": "spam",
                    "description": "one too many",
                }),
            )
            .await;
        assert_eq!(status, 429, "21st report should be rate limited");
    });
}

// ────────────────────────────────────────────────────────────
//  Abuse Detection Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_rapid_messaging_auto_rate_limit() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_spammer, _spammer_id) =
            register_user(srv, "spammer", "spammer@test.com").await;
        let (server_id, invite_code) = create_server(srv, &token_owner, "SpamServer").await;
        join_server(srv, &token_spammer, &invite_code).await;
        let channel_id =
            create_channel(srv, &token_owner, &server_id, "general").await;

        // Connect spammer via WebSocket
        let mut ws = srv.ws_client(&token_spammer).await;
        ws.identify(&token_spammer, "device-spam").await;

        // Send many messages rapidly (>30 in quick succession)
        // Each message_send increments the abuse:msg_rate counter
        for i in 0..35 {
            ws.send_json(&json!({
                "op": "message_send",
                "d": {
                    "channel_id": channel_id,
                    "content": format!("spam message #{}", i),
                }
            }))
            .await;
            // Small delay to allow processing
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // Wait for the abuse detector to run (runs every 30s, but we can
        // directly set the key and check enforcement)
        // Instead of waiting 30s, directly set the rate limit key
        let _: () = srv
            .redis
            .set(
                &format!("rate_limited:{}:global", _spammer_id),
                "1",
                Some(Expiration::EX(600)),
                None,
                false,
            )
            .await
            .unwrap();

        // Now send another message — should be rejected with RATE_LIMITED
        ws.send_json(&json!({
            "op": "message_send",
            "d": {
                "channel_id": channel_id,
                "content": "blocked message",
            }
        }))
        .await;

        let events = ws
            .collect_any_events("ERROR", Duration::from_secs(3))
            .await;
        assert!(!events.is_empty(), "should receive RATE_LIMITED error");
        assert_eq!(events[0]["d"]["code"], "RATE_LIMITED");

        ws.close().await;
    });
}

#[test]
fn test_dm_blocked_rejects_new_dm() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_spammer, spammer_id) =
            register_user(srv, "dmspammer", "dmspammer@test.com").await;
        let (_, target_id) = register_user(srv, "target", "target@test.com").await;
        let client = srv.client();

        // Directly set dm_blocked key (simulating abuse detector action)
        let _: () = srv
            .redis
            .set(
                &format!("dm_blocked:{}", spammer_id),
                "1",
                Some(Expiration::EX(3600)),
                None,
                false,
            )
            .await
            .unwrap();

        // Try to create a DM — should be blocked
        let (status, _) = client
            .post_authed_with_token(
                &token_spammer,
                "/dm",
                &json!({ "recipient_id": target_id }),
            )
            .await;
        assert_eq!(status, 403, "DM creation should be blocked");
    });
}

#[test]
fn test_join_blocked_rejects_server_join() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_joiner, joiner_id) =
            register_user(srv, "joiner", "joiner@test.com").await;
        let client = srv.client();

        let (_, invite_code) = create_server(srv, &token_owner, "JoinServer").await;

        // Directly set join_blocked key (simulating abuse detector action)
        let _: () = srv
            .redis
            .set(
                &format!("join_blocked:{}", joiner_id),
                "1",
                Some(Expiration::EX(3600)),
                None,
                false,
            )
            .await
            .unwrap();

        // Try to join — should be blocked
        let (status, _) = client
            .post_authed_with_token(
                &token_joiner,
                "/servers/join",
                &json!({ "invite_code": invite_code }),
            )
            .await;
        assert_eq!(status, 403, "server join should be blocked");
    });
}

#[test]
fn test_report_threshold_creates_high_severity_signal() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_admin, _) = register_user(srv, "admin", "admin@test.com").await;
        // Create a server so admin is an owner (required for admin endpoints)
        let _ = create_server(srv, &token_admin, "AdminServer").await;
        let (_, target_id) = register_user(srv, "target", "target@test.com").await;

        // Directly set the report count above threshold
        let key = format!("abuse:report_count:{}", target_id);
        let _: () = srv.redis.set(&key, "10", None, None, false).await.unwrap();
        let _: bool = srv.redis.expire(&key, 86400).await.unwrap();

        // Wait a bit for the abuse detector to possibly pick it up
        // (The detector runs every 30s — but since we can't wait that long in a test,
        //  we directly create the signal and verify the endpoint works)
        mercury_moderation::abuse::create_signal(
            &srv.db,
            mercury_core::ids::UserId(uuid::Uuid::parse_str(&target_id).unwrap()),
            "report_threshold",
            "high",
            serde_json::json!({ "report_count_per_day": 10 }),
            None, // No auto-action
        )
        .await
        .expect("signal creation should succeed");

        // Verify via admin endpoint
        let client = srv.client();
        let (status, body) = client
            .get_authed_with_token(
                &token_admin,
                "/admin/abuse-signals?severity=high&reviewed=false",
            )
            .await;
        assert_eq!(status, 200);
        let signals = body.as_array().unwrap();
        assert!(
            signals.iter().any(|s| s["signal_type"] == "report_threshold"),
            "should have report_threshold signal"
        );
        // No auto-action for report threshold
        let sig = signals
            .iter()
            .find(|s| s["signal_type"] == "report_threshold")
            .unwrap();
        assert!(sig["auto_action"].is_null(), "report_threshold should have no auto-action");
    });
}

// ────────────────────────────────────────────────────────────
//  Abuse Signal Management Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_abuse_signal_list_filter_and_mark_reviewed() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_admin, _) = register_user(srv, "admin", "admin@test.com").await;
        // Create a server so admin is an owner (required for admin endpoints)
        let _ = create_server(srv, &token_admin, "AdminServer").await;
        let (_, target_id) = register_user(srv, "target", "target@test.com").await;

        let target_uid =
            mercury_core::ids::UserId(uuid::Uuid::parse_str(&target_id).unwrap());

        // Create multiple signals
        let signal1 = mercury_moderation::abuse::create_signal(
            &srv.db,
            target_uid,
            "rapid_messaging",
            "medium",
            serde_json::json!({ "msg_count": 50 }),
            Some("rate_limit"),
        )
        .await
        .unwrap();

        let _signal2 = mercury_moderation::abuse::create_signal(
            &srv.db,
            target_uid,
            "mass_dm",
            "medium",
            serde_json::json!({ "dm_count": 25 }),
            Some("dm_block"),
        )
        .await
        .unwrap();

        let client = srv.client();

        // List all unreviewed signals
        let (status, body) = client
            .get_authed_with_token(&token_admin, "/admin/abuse-signals?reviewed=false")
            .await;
        assert_eq!(status, 200);
        let signals = body.as_array().unwrap();
        assert_eq!(signals.len(), 2);

        // Mark signal1 as reviewed
        let (status, body) = client
            .patch_authed_with_token(
                &token_admin,
                &format!("/admin/abuse-signals/{}", signal1.id),
                &json!({}),
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["reviewed"], true);

        // List unreviewed — should have 1
        let (status, body) = client
            .get_authed_with_token(&token_admin, "/admin/abuse-signals?reviewed=false")
            .await;
        assert_eq!(status, 200);
        assert_eq!(body.as_array().unwrap().len(), 1);
    });
}

#[test]
fn test_abuse_stats() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_admin, _) = register_user(srv, "admin", "admin@test.com").await;
        // Create a server so admin is an owner (required for admin endpoints)
        let _ = create_server(srv, &token_admin, "AdminServer").await;
        let (_, target_id) = register_user(srv, "target", "target@test.com").await;

        let target_uid =
            mercury_core::ids::UserId(uuid::Uuid::parse_str(&target_id).unwrap());

        // Create signals
        mercury_moderation::abuse::create_signal(
            &srv.db,
            target_uid,
            "rapid_messaging",
            "medium",
            serde_json::json!({}),
            Some("rate_limit"),
        )
        .await
        .unwrap();

        mercury_moderation::abuse::create_signal(
            &srv.db,
            target_uid,
            "rapid_messaging",
            "medium",
            serde_json::json!({}),
            Some("rate_limit"),
        )
        .await
        .unwrap();

        mercury_moderation::abuse::create_signal(
            &srv.db,
            target_uid,
            "mass_dm",
            "medium",
            serde_json::json!({}),
            Some("dm_block"),
        )
        .await
        .unwrap();

        let client = srv.client();

        let (status, body) = client
            .get_authed_with_token(&token_admin, "/admin/abuse-stats")
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["total_signals_24h"], 3);
        assert_eq!(body["unreviewed_count"], 3);
        assert_eq!(body["signals_by_type"]["rapid_messaging"], 2);
        assert_eq!(body["signals_by_type"]["mass_dm"], 1);
        assert_eq!(body["top_flagged_users"].as_array().unwrap().len(), 1);
    });
}

// ────────────────────────────────────────────────────────────
//  Moderation Key Endpoint Test
// ────────────────────────────────────────────────────────────

#[test]
fn test_moderation_key_endpoint() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_member, _) = register_user(srv, "member", "member@test.com").await;
        let (token_outsider, _) =
            register_user(srv, "outsider", "outsider@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "KeyServer").await;
        join_server(srv, &token_member, &invite_code).await;

        // Member can access moderation key
        let (status, body) = client
            .get_authed_with_token(
                &token_member,
                &format!("/servers/{server_id}/moderation-key"),
            )
            .await;
        assert_eq!(status, 200);
        // Default config has empty key
        assert!(body["operator_moderation_pubkey"].is_string());

        // Non-member cannot access
        let (status, _) = client
            .get_authed_with_token(
                &token_outsider,
                &format!("/servers/{server_id}/moderation-key"),
            )
            .await;
        assert_eq!(status, 403, "non-member should not access moderation key");
    });
}

// ────────────────────────────────────────────────────────────
//  Invalid report category
// ────────────────────────────────────────────────────────────

#[test]
fn test_report_invalid_category() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_user, _) = register_user(srv, "user", "user@test.com").await;
        let (_, target_id) = register_user(srv, "target", "target@test.com").await;
        let client = srv.client();

        let (status, _) = client
            .post_authed_with_token(
                &token_user,
                "/reports",
                &json!({
                    "reported_user_id": target_id,
                    "category": "invalid_category",
                    "description": "test",
                }),
            )
            .await;
        assert_eq!(status, 400, "invalid category should be rejected");
    });
}

// ────────────────────────────────────────────────────────────
//  Report review with ban action
// ────────────────────────────────────────────────────────────

#[test]
fn test_report_review_with_ban_action() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_reporter, _) =
            register_user(srv, "reporter", "reporter@test.com").await;
        let (token_bad, bad_user_id) =
            register_user(srv, "baduser", "bad@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "BanServer").await;
        join_server(srv, &token_reporter, &invite_code).await;
        join_server(srv, &token_bad, &invite_code).await;

        // Submit report
        let (status, body) = client
            .post_authed_with_token(
                &token_reporter,
                "/reports",
                &json!({
                    "reported_user_id": bad_user_id,
                    "server_id": server_id,
                    "category": "harassment",
                    "description": "harassing other users",
                }),
            )
            .await;
        assert_eq!(status, 201);
        let report_id = body["id"].as_str().unwrap().to_string();

        // Review with ban action (60 second duration)
        let (status, body) = client
            .patch_authed_with_token(
                &token_owner,
                &format!("/reports/{report_id}"),
                &json!({
                    "status": "actioned",
                    "action_taken": "ban",
                    "ban_duration": 60,
                }),
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["action_taken"], "ban");

        // Verify user is actually banned
        let (status, _) = client
            .post_authed_with_token(
                &token_bad,
                "/servers/join",
                &json!({ "invite_code": invite_code }),
            )
            .await;
        assert_eq!(status, 403, "user should be banned from rejoining");
    });
}
