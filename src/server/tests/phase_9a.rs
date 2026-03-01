mod common;

use common::{setup, TestServer};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::time::sleep;

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

    fn put_authed_with_token(
        &self,
        token: &str,
        path: &str,
        body: &Value,
    ) -> impl std::future::Future<Output = (reqwest::StatusCode, Value)>;

    fn delete_authed_with_token(
        &self,
        token: &str,
        path: &str,
    ) -> impl std::future::Future<Output = reqwest::StatusCode>;
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

    async fn put_authed_with_token(
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
            .put(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .json(body)
            .send()
            .await
            .expect("PUT request failed");
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(json!({}));
        (status, body)
    }

    async fn delete_authed_with_token(
        &self,
        token: &str,
        path: &str,
    ) -> reqwest::StatusCode {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let resp = client
            .delete(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .expect("DELETE request failed");
        resp.status()
    }
}

// ────────────────────────────────────────────────────────────
//  Block Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_block_user_and_list() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_a, _user_a) = register_user(srv, "alice", "alice@test.com").await;
        let (_token_b, user_b) = register_user(srv, "bob", "bob@test.com").await;
        let client = srv.client();

        // Block bob
        let status = client
            .put_authed_with_token(&token_a, &format!("/users/me/blocks/{user_b}"), &json!({}))
            .await
            .0;
        assert_eq!(status, 204, "block should succeed");

        // List blocks
        let (status, body) = client
            .get_authed_with_token(&token_a, "/users/me/blocks")
            .await;
        assert_eq!(status, 200);
        let blocks = body.as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["user_id"], user_b);

        // Unblock bob
        let status = client
            .delete_authed_with_token(&token_a, &format!("/users/me/blocks/{user_b}"))
            .await;
        assert_eq!(status, 204, "unblock should succeed");

        // List blocks — should be empty
        let (status, body) = client
            .get_authed_with_token(&token_a, "/users/me/blocks")
            .await;
        assert_eq!(status, 200);
        assert_eq!(body.as_array().unwrap().len(), 0);
    });
}

#[test]
fn test_block_self_rejected() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_a, user_a) = register_user(srv, "alice", "alice@test.com").await;
        let client = srv.client();

        let (status, _) = client
            .put_authed_with_token(&token_a, &format!("/users/me/blocks/{user_a}"), &json!({}))
            .await;
        assert_eq!(status, 400, "cannot block yourself");
    });
}

// ────────────────────────────────────────────────────────────
//  DM Policy Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_dm_policy_set() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_a, _) = register_user(srv, "alice", "alice@test.com").await;
        let client = srv.client();

        // Set to "nobody"
        let (status, body) = client
            .put_authed_with_token(
                &token_a,
                "/users/me/dm-policy",
                &json!({ "policy": "nobody" }),
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["dm_policy"], "nobody");

        // Set to "mutual_servers"
        let (status, body) = client
            .put_authed_with_token(
                &token_a,
                "/users/me/dm-policy",
                &json!({ "policy": "mutual_servers" }),
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["dm_policy"], "mutual_servers");

        // Invalid policy
        let (status, _) = client
            .put_authed_with_token(
                &token_a,
                "/users/me/dm-policy",
                &json!({ "policy": "invalid" }),
            )
            .await;
        assert_eq!(status, 400);
    });
}

// ────────────────────────────────────────────────────────────
//  Ban Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_ban_user_and_access_denied() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_user, user_id) = register_user(srv, "baduser", "bad@test.com").await;
        let client = srv.client();

        // Owner creates server
        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;

        // User joins
        join_server(srv, &token_user, &invite_code).await;

        // Owner bans user
        let (status, body) = client
            .post_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/bans"),
                &json!({
                    "user_id": user_id,
                    "reason": "bad behavior"
                }),
            )
            .await;
        assert_eq!(status, 201, "ban should succeed");
        assert_eq!(body["user_id"], user_id);

        // Banned user cannot access server
        let (status, body) = client
            .get_authed_with_token(&token_user, &format!("/servers/{server_id}"))
            .await;
        assert_eq!(status, 403, "banned user should be denied");
        assert!(
            body["error"].as_str().unwrap().contains("BANNED")
                || body["error"].as_str().unwrap().contains("not a member"),
            "should indicate ban or non-membership"
        );

        // Banned user cannot rejoin
        let (status, _) = client
            .post_authed_with_token(
                &token_user,
                "/servers/join",
                &json!({ "invite_code": invite_code }),
            )
            .await;
        assert_eq!(status, 403, "banned user should not be able to rejoin");

        // List bans
        let (status, body) = client
            .get_authed_with_token(&token_owner, &format!("/servers/{server_id}/bans"))
            .await;
        assert_eq!(status, 200);
        let bans = body.as_array().unwrap();
        assert_eq!(bans.len(), 1);

        // Unban
        let status = client
            .delete_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/bans/{user_id}"),
            )
            .await;
        assert_eq!(status, 204);

        // User can now rejoin
        let (status, _) = client
            .post_authed_with_token(
                &token_user,
                "/servers/join",
                &json!({ "invite_code": invite_code }),
            )
            .await;
        assert_eq!(status, 200, "unbanned user should be able to rejoin");
    });
}

#[test]
fn test_ban_owner_rejected() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, owner_id) = register_user(srv, "owner", "owner@test.com").await;
        let (token_mod, mod_id) = register_user(srv, "mod", "mod@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_mod, &invite_code).await;

        // Promote mod
        let (status, _) = client
            .put_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/moderators/{mod_id}"),
                &json!({}),
            )
            .await;
        assert_eq!(status, 204);

        // Mod tries to ban owner → 403
        let (status, _) = client
            .post_authed_with_token(
                &token_mod,
                &format!("/servers/{server_id}/bans"),
                &json!({ "user_id": owner_id }),
            )
            .await;
        assert_eq!(status, 403, "mod cannot ban owner");
    });
}

#[test]
fn test_temp_ban_expiry() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_user, user_id) = register_user(srv, "tempbanned", "temp@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_user, &invite_code).await;

        // Ban for 2 seconds
        let expires = chrono::Utc::now() + chrono::Duration::seconds(2);
        let (status, _) = client
            .post_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/bans"),
                &json!({
                    "user_id": user_id,
                    "expires_at": expires.to_rfc3339(),
                }),
            )
            .await;
        assert_eq!(status, 201);

        // User is banned
        let (status, _) = client
            .post_authed_with_token(
                &token_user,
                "/servers/join",
                &json!({ "invite_code": invite_code }),
            )
            .await;
        assert_eq!(status, 403, "temp-banned user should be denied");

        // Wait for expiry + cleanup
        sleep(Duration::from_secs(3)).await;

        // Trigger cleanup by running the cleanup function directly
        mercury_moderation::bans::cleanup_expired_bans(&srv.db, &srv.redis)
            .await
            .expect("cleanup should succeed");

        // User can now rejoin
        let (status, _) = client
            .post_authed_with_token(
                &token_user,
                "/servers/join",
                &json!({ "invite_code": invite_code }),
            )
            .await;
        assert_eq!(status, 200, "temp ban should have expired");
    });
}

// ────────────────────────────────────────────────────────────
//  Kick Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_kick_user_can_rejoin() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_user, user_id) = register_user(srv, "kickme", "kick@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_user, &invite_code).await;

        // Kick user
        let (status, _) = client
            .post_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/kicks/{user_id}"),
                &json!({ "reason": "misbehaving" }),
            )
            .await;
        assert_eq!(status, 204, "kick should succeed");

        // User is no longer a member
        let (status, _) = client
            .get_authed_with_token(&token_user, &format!("/servers/{server_id}"))
            .await;
        assert_eq!(status, 403, "kicked user should not be a member");

        // User can rejoin (not banned)
        let (status, _) = client
            .post_authed_with_token(
                &token_user,
                "/servers/join",
                &json!({ "invite_code": invite_code }),
            )
            .await;
        assert_eq!(status, 200, "kicked user should be able to rejoin");
    });
}

#[test]
fn test_kick_owner_rejected() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, owner_id) = register_user(srv, "owner", "owner@test.com").await;
        let (token_mod, mod_id) = register_user(srv, "mod", "mod@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_mod, &invite_code).await;

        // Promote mod
        let (status, _) = client
            .put_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/moderators/{mod_id}"),
                &json!({}),
            )
            .await;
        assert_eq!(status, 204);

        // Mod tries to kick owner → 403
        let (status, _) = client
            .post_authed_with_token(
                &token_mod,
                &format!("/servers/{server_id}/kicks/{owner_id}"),
                &json!({}),
            )
            .await;
        assert_eq!(status, 403, "mod cannot kick owner");
    });
}

// ────────────────────────────────────────────────────────────
//  Channel Mute Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_channel_mute_blocks_messages() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_user, user_id) = register_user(srv, "chatty", "chatty@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_user, &invite_code).await;
        let channel_id = create_channel(srv, &token_owner, &server_id, "general").await;

        // Mute user in channel
        let (status, body) = client
            .post_authed_with_token(
                &token_owner,
                &format!("/channels/{channel_id}/mutes"),
                &json!({
                    "user_id": user_id,
                    "reason": "too chatty"
                }),
            )
            .await;
        assert_eq!(status, 201, "mute should succeed");
        assert_eq!(body["user_id"], user_id);

        // Connect muted user via WebSocket and try to send message
        let mut ws = srv.ws_client(&token_user).await;
        ws.identify(&token_user, "device-muted").await;

        // Send message to channel — should get CHANNEL_MUTED error
        ws.send_json(&json!({
            "op": "message_send",
            "d": {
                "channel_id": channel_id,
                "content": "I'm muted!"
            }
        }))
        .await;

        // Drain events until we find the ERROR event
        let events = ws.collect_any_events("ERROR", Duration::from_secs(3)).await;
        assert!(!events.is_empty(), "should receive CHANNEL_MUTED error");
        assert_eq!(events[0]["d"]["code"], "CHANNEL_MUTED");

        ws.close().await;

        // Unmute
        let status = client
            .delete_authed_with_token(
                &token_owner,
                &format!("/channels/{channel_id}/mutes/{user_id}"),
            )
            .await;
        assert_eq!(status, 204, "unmute should succeed");

        // Now message should work
        let mut ws2 = srv.ws_client(&token_user).await;
        ws2.identify(&token_user, "device-unmuted").await;

        ws2.send_json(&json!({
            "op": "message_send",
            "d": {
                "channel_id": channel_id,
                "content": "I'm free!"
            }
        }))
        .await;

        let events = ws2.collect_any_events("MESSAGE_CREATE", Duration::from_secs(3)).await;
        assert!(!events.is_empty(), "should receive MESSAGE_CREATE after unmute");

        ws2.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  Moderator Promotion/Demotion Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_moderator_can_ban_kick_mute() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_mod, mod_id) = register_user(srv, "mod", "mod@test.com").await;
        let (token_user, user_id) = register_user(srv, "target", "target@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_mod, &invite_code).await;
        join_server(srv, &token_user, &invite_code).await;
        let channel_id = create_channel(srv, &token_owner, &server_id, "general").await;

        // Promote mod
        let (status, _) = client
            .put_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/moderators/{mod_id}"),
                &json!({}),
            )
            .await;
        assert_eq!(status, 204);

        // Mod can mute user in channel
        let (status, _) = client
            .post_authed_with_token(
                &token_mod,
                &format!("/channels/{channel_id}/mutes"),
                &json!({ "user_id": user_id }),
            )
            .await;
        assert_eq!(status, 201, "mod should be able to mute");

        // Unmute to clean up
        let status = client
            .delete_authed_with_token(
                &token_mod,
                &format!("/channels/{channel_id}/mutes/{user_id}"),
            )
            .await;
        assert_eq!(status, 204);

        // Mod can kick user
        let (status, _) = client
            .post_authed_with_token(
                &token_mod,
                &format!("/servers/{server_id}/kicks/{user_id}"),
                &json!({}),
            )
            .await;
        assert_eq!(status, 204, "mod should be able to kick");
    });
}

#[test]
fn test_moderator_cannot_promote() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_mod, mod_id) = register_user(srv, "mod", "mod@test.com").await;
        let (_, user_id) = register_user(srv, "regular", "regular@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_mod, &invite_code).await;

        // Promote mod
        let (status, _) = client
            .put_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/moderators/{mod_id}"),
                &json!({}),
            )
            .await;
        assert_eq!(status, 204);

        // Mod tries to promote another user → 403 (owner only)
        let (status, _) = client
            .put_authed_with_token(
                &token_mod,
                &format!("/servers/{server_id}/moderators/{user_id}"),
                &json!({}),
            )
            .await;
        assert_eq!(status, 403, "mod cannot promote others");
    });
}

// ────────────────────────────────────────────────────────────
//  Non-member/Non-mod Access Denied
// ────────────────────────────────────────────────────────────

#[test]
fn test_non_member_cannot_access_moderation() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_outsider, _) = register_user(srv, "outsider", "outsider@test.com").await;
        let client = srv.client();

        let (server_id, _) = create_server(srv, &token_owner, "TestServer").await;

        // Outsider tries to list bans → 403
        let (status, _) = client
            .get_authed_with_token(&token_outsider, &format!("/servers/{server_id}/bans"))
            .await;
        assert_eq!(status, 403, "non-member cannot list bans");

        // Outsider tries to view audit log → 403
        let (status, _) = client
            .get_authed_with_token(&token_outsider, &format!("/servers/{server_id}/audit-log"))
            .await;
        assert_eq!(status, 403, "non-member cannot view audit log");
    });
}

#[test]
fn test_regular_member_cannot_moderate() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_regular, _regular_id) =
            register_user(srv, "regular", "regular@test.com").await;
        let (_, target_id) = register_user(srv, "target", "target@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_regular, &invite_code).await;

        // Regular member tries to ban → 403
        let (status, _) = client
            .post_authed_with_token(
                &token_regular,
                &format!("/servers/{server_id}/bans"),
                &json!({ "user_id": target_id }),
            )
            .await;
        assert_eq!(status, 403, "regular member cannot ban");

        // Regular member tries to list bans → 403
        let (status, _) = client
            .get_authed_with_token(&token_regular, &format!("/servers/{server_id}/bans"))
            .await;
        assert_eq!(status, 403, "regular member cannot list bans");
    });
}

// ────────────────────────────────────────────────────────────
//  Audit Log Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_audit_log_records_actions() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (_, _mod_id) = register_user(srv, "mod", "mod@test.com").await;
        let (token_user, user_id) = register_user(srv, "target", "target@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_user, &invite_code).await;

        // Promote mod (mod needs to join first)
        let (token_mod, _) = register_user(srv, "mod2", "mod2@test.com").await;
        join_server(srv, &token_mod, &invite_code).await;

        // Ban user
        let (status, _) = client
            .post_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/bans"),
                &json!({ "user_id": user_id, "reason": "test ban" }),
            )
            .await;
        assert_eq!(status, 201);

        // Unban user
        let status = client
            .delete_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/bans/{user_id}"),
            )
            .await;
        assert_eq!(status, 204);

        // Check audit log
        let (status, body) = client
            .get_authed_with_token(&token_owner, &format!("/servers/{server_id}/audit-log"))
            .await;
        assert_eq!(status, 200);
        let entries = body.as_array().unwrap();
        assert!(entries.len() >= 2, "should have at least ban + unban entries");

        // Newest first
        assert_eq!(entries[0]["action"], "unban");
        assert_eq!(entries[1]["action"], "ban");
        assert_eq!(entries[1]["target_user_id"], user_id);

        // Filter by action
        let (status, body) = client
            .get_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/audit-log?action=ban"),
            )
            .await;
        assert_eq!(status, 200);
        let entries = body.as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["action"], "ban");
    });
}

// ────────────────────────────────────────────────────────────
//  WebSocket Ban/Kick Event Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_ban_sends_websocket_event() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_user, user_id) = register_user(srv, "target", "target@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_user, &invite_code).await;

        // Connect target user via WebSocket
        let mut ws = srv.ws_client(&token_user).await;
        ws.identify(&token_user, "device-target").await;

        // Owner bans the user
        let (status, _) = client
            .post_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/bans"),
                &json!({ "user_id": user_id }),
            )
            .await;
        assert_eq!(status, 201);

        // Target should receive USER_BANNED event (drain other events first)
        let events = ws.collect_any_events("USER_BANNED", Duration::from_secs(3)).await;
        assert!(!events.is_empty(), "should receive USER_BANNED event");
        assert_eq!(events[0]["d"]["user_id"], user_id);
        assert_eq!(events[0]["d"]["server_id"], server_id);

        ws.close().await;
    });
}

#[test]
fn test_kick_sends_websocket_event() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_user, user_id) = register_user(srv, "target", "target@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_user, &invite_code).await;

        // Connect target user via WebSocket
        let mut ws = srv.ws_client(&token_user).await;
        ws.identify(&token_user, "device-target").await;

        // Owner kicks the user
        let (status, _) = client
            .post_authed_with_token(
                &token_owner,
                &format!("/servers/{server_id}/kicks/{user_id}"),
                &json!({}),
            )
            .await;
        assert_eq!(status, 204);

        // Target should receive USER_KICKED event (drain other events first)
        let events = ws.collect_any_events("USER_KICKED", Duration::from_secs(3)).await;
        assert!(!events.is_empty(), "should receive USER_KICKED event");
        assert_eq!(events[0]["d"]["user_id"], user_id);

        ws.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  Mute/Unmute WebSocket Event Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_mute_unmute_websocket_events() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (token_user, user_id) = register_user(srv, "chatty", "chatty@test.com").await;
        let client = srv.client();

        let (server_id, invite_code) = create_server(srv, &token_owner, "TestServer").await;
        join_server(srv, &token_user, &invite_code).await;
        let channel_id = create_channel(srv, &token_owner, &server_id, "general").await;

        // Connect user via WebSocket
        let mut ws = srv.ws_client(&token_user).await;
        ws.identify(&token_user, "device-user").await;

        // Mute user
        let (status, _) = client
            .post_authed_with_token(
                &token_owner,
                &format!("/channels/{channel_id}/mutes"),
                &json!({ "user_id": user_id }),
            )
            .await;
        assert_eq!(status, 201);

        // Should receive USER_MUTED event (drain other events first)
        let events = ws.collect_any_events("USER_MUTED", Duration::from_secs(3)).await;
        assert!(!events.is_empty(), "should receive mute event");
        assert_eq!(events[0]["d"]["user_id"], user_id);
        assert_eq!(events[0]["d"]["channel_id"], channel_id);

        // Unmute user
        let status = client
            .delete_authed_with_token(
                &token_owner,
                &format!("/channels/{channel_id}/mutes/{user_id}"),
            )
            .await;
        assert_eq!(status, 204);

        // Should receive USER_UNMUTED event
        let events = ws.collect_any_events("USER_UNMUTED", Duration::from_secs(3)).await;
        assert!(!events.is_empty(), "should receive unmute event");
        assert_eq!(events[0]["d"]["user_id"], user_id);
        assert_eq!(events[0]["d"]["channel_id"], channel_id);

        ws.close().await;
    });
}
