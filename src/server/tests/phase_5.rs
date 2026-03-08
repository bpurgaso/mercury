mod common;

use common::{setup, TestServer};
use serde_json::json;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::time::sleep;

// ────────────────────────────────────────────────────────────
//  Shared infrastructure (same pattern as milestone_1)
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
    SERVER.get_or_init(|| runtime().block_on(TestServer::start_with_auth_rate_limit(100)))
}

/// Register a user and return a TestClient with tokens set.
async fn register_client(
    srv: &TestServer,
    username: &str,
    email: &str,
) -> common::TestClient {
    let mut client = srv.client();
    let (status, _) = client.register_raw(username, email, "password123").await;
    assert_eq!(status, 201, "registration should succeed for {username}");
    client
}

// ────────────────────────────────────────────────────────────
//  5a. Server CRUD
// ────────────────────────────────────────────────────────────

// TESTSPEC: API-019
#[test]
fn test_create_server() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let client = register_client(srv, "srvowner", "srvowner@example.com").await;

        let (status, body) = client
            .post_authed("/servers", &json!({ "name": "My Server" }))
            .await;

        assert_eq!(status, 201, "create server should return 201");
        assert!(body["id"].is_string(), "response should contain server id");
        assert_eq!(body["name"], "My Server");
        assert_eq!(
            body["owner_id"],
            client.user_id.as_ref().unwrap().as_str()
        );
        assert!(body["invite_code"].is_string(), "should have invite_code");
        assert_eq!(body["invite_code"].as_str().unwrap().len(), 8);
    });
}

// TESTSPEC: API-020
#[test]
fn test_list_servers() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let client = register_client(srv, "listowner", "listowner@example.com").await;

        // Create two servers
        client
            .post_authed("/servers", &json!({ "name": "Server A" }))
            .await;
        client
            .post_authed("/servers", &json!({ "name": "Server B" }))
            .await;

        let (status, body) = client.get_authed("/servers").await;
        assert_eq!(status, 200);
        let servers = body.as_array().expect("should be an array");
        assert_eq!(servers.len(), 2, "user should see 2 servers");
    });
}

// TESTSPEC: API-022
#[test]
fn test_get_server_requires_membership() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "getowner", "getowner@example.com").await;
        let outsider = register_client(srv, "outsider", "outsider@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "Private" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();

        // Owner can get
        let (status, body) = owner
            .get_authed(&format!("/servers/{}", server_id))
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["name"], "Private");

        // Non-member gets 403
        let (status, _) = outsider
            .get_authed(&format!("/servers/{}", server_id))
            .await;
        assert_eq!(status, 403, "non-member should get 403");
    });
}

// TESTSPEC: API-023
#[test]
fn test_update_server_owner_only() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "updowner", "updowner@example.com").await;
        let member = register_client(srv, "updmember", "updmember@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "Original" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();
        let invite_code = server_body["invite_code"].as_str().unwrap();

        // Member joins
        member
            .post_authed("/servers/join", &json!({ "invite_code": invite_code }))
            .await;

        // Owner can update
        let (status, body) = owner
            .patch_authed(
                &format!("/servers/{}", server_id),
                &json!({ "name": "Updated" }),
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["name"], "Updated");

        // Member cannot update
        let (status, _) = member
            .patch_authed(
                &format!("/servers/{}", server_id),
                &json!({ "name": "Hacked" }),
            )
            .await;
        assert_eq!(status, 403, "non-owner should get 403 on update");
    });
}

// TESTSPEC: API-024
#[test]
fn test_delete_server_owner_only() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "delowner", "delowner@example.com").await;
        let member = register_client(srv, "delmember", "delmember@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "ToDelete" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();
        let invite_code = server_body["invite_code"].as_str().unwrap();

        member
            .post_authed("/servers/join", &json!({ "invite_code": invite_code }))
            .await;

        // Member cannot delete
        let status = member.delete_authed(&format!("/servers/{}", server_id)).await;
        assert_eq!(status, 403, "non-owner should get 403 on delete");

        // Owner can delete
        let status = owner.delete_authed(&format!("/servers/{}", server_id)).await;
        assert_eq!(status, 204, "owner should be able to delete");

        // Server should be gone
        let (status, _) = owner
            .get_authed(&format!("/servers/{}", server_id))
            .await;
        assert!(
            status == 403 || status == 404,
            "deleted server should not be accessible"
        );
    });
}

// TESTSPEC: API-025
#[test]
fn test_join_server_via_invite_code() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "joinowner", "joinowner@example.com").await;
        let joiner = register_client(srv, "joiner", "joiner@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "Join Me" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();
        let invite_code = server_body["invite_code"].as_str().unwrap();

        // Join via invite code
        let (status, body) = joiner
            .post_authed("/servers/join", &json!({ "invite_code": invite_code }))
            .await;
        assert_eq!(status, 200, "join should succeed");
        assert_eq!(body["id"], server_id);

        // Joiner can now access the server
        let (status, _) = joiner
            .get_authed(&format!("/servers/{}", server_id))
            .await;
        assert_eq!(status, 200, "joined user should be able to get server");

        // Double-join should be conflict
        let (status, _) = joiner
            .post_authed("/servers/join", &json!({ "invite_code": invite_code }))
            .await;
        assert_eq!(status, 409, "double join should return 409");
    });
}

// TESTSPEC: API-026
#[test]
fn test_join_invalid_invite_code() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let client = register_client(srv, "badinvite", "badinvite@example.com").await;

        let (status, _) = client
            .post_authed("/servers/join", &json!({ "invite_code": "INVALID1" }))
            .await;
        assert_eq!(status, 404, "invalid invite code should return 404");
    });
}

// TESTSPEC: API-027
#[test]
fn test_leave_server() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "leaveowner", "leaveowner@example.com").await;
        let member = register_client(srv, "leaver", "leaver@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "Leavable" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();
        let invite_code = server_body["invite_code"].as_str().unwrap();

        member
            .post_authed("/servers/join", &json!({ "invite_code": invite_code }))
            .await;

        // Member leaves
        let status = member
            .delete_authed(&format!("/servers/{}/members/me", server_id))
            .await;
        assert_eq!(status, 204, "leave should return 204");

        // After leaving, can't access
        let (status, _) = member
            .get_authed(&format!("/servers/{}", server_id))
            .await;
        assert_eq!(status, 403, "left user should get 403");
    });
}

// TESTSPEC: API-028
#[test]
fn test_owner_cannot_leave_server() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "noleave", "noleave@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "MyServer" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();

        let status = owner
            .delete_authed(&format!("/servers/{}/members/me", server_id))
            .await;
        assert_eq!(status, 400, "owner should not be able to leave their server");
    });
}

// ────────────────────────────────────────────────────────────
//  5b. Channel CRUD
// ────────────────────────────────────────────────────────────

// TESTSPEC: API-029
#[test]
fn test_create_channel() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "chowner", "chowner@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "ChServer" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();

        let (status, body) = owner
            .post_authed(
                &format!("/servers/{}/channels", server_id),
                &json!({
                    "name": "general",
                    "encryption_mode": "standard"
                }),
            )
            .await;

        assert_eq!(status, 201, "create channel should return 201");
        assert_eq!(body["name"], "general");
        assert_eq!(body["encryption_mode"], "standard");
        assert_eq!(body["server_id"], server_id);
    });
}

#[test]
fn test_create_channel_requires_encryption_mode() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "chenc", "chenc@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "EncServer" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();

        // Invalid encryption mode
        let (status, _) = owner
            .post_authed(
                &format!("/servers/{}/channels", server_id),
                &json!({
                    "name": "bad",
                    "encryption_mode": "invalid_mode"
                }),
            )
            .await;
        assert_eq!(status, 400, "invalid encryption_mode should return 400");
    });
}

// TESTSPEC: API-032
#[test]
fn test_list_channels() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "chlist", "chlist@example.com").await;
        let member = register_client(srv, "chmember", "chmember@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "ListChServer" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();
        let invite_code = server_body["invite_code"].as_str().unwrap();

        owner
            .post_authed(
                &format!("/servers/{}/channels", server_id),
                &json!({ "name": "general", "encryption_mode": "standard" }),
            )
            .await;
        owner
            .post_authed(
                &format!("/servers/{}/channels", server_id),
                &json!({ "name": "private", "encryption_mode": "private" }),
            )
            .await;

        // Member joins and lists
        member
            .post_authed("/servers/join", &json!({ "invite_code": invite_code }))
            .await;

        let (status, body) = member
            .get_authed(&format!("/servers/{}/channels", server_id))
            .await;
        assert_eq!(status, 200);
        let channels = body.as_array().expect("should be an array");
        assert_eq!(channels.len(), 2);
    });
}

#[test]
fn test_list_channels_requires_membership() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "chlistauth", "chlistauth@example.com").await;
        let outsider = register_client(srv, "chlistout", "chlistout@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "AuthChServer" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();

        let (status, _) = outsider
            .get_authed(&format!("/servers/{}/channels", server_id))
            .await;
        assert_eq!(status, 403, "non-member should get 403 on list channels");
    });
}

// TESTSPEC: API-033
#[test]
fn test_delete_channel() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "chdel", "chdel@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "DelChServer" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();

        let (_, ch_body) = owner
            .post_authed(
                &format!("/servers/{}/channels", server_id),
                &json!({ "name": "todelete", "encryption_mode": "standard" }),
            )
            .await;
        let channel_id = ch_body["id"].as_str().unwrap();

        let status = owner
            .delete_authed(&format!("/channels/{}", channel_id))
            .await;
        assert_eq!(status, 204, "delete channel should return 204");

        // Channel should be gone from list
        let (_, body) = owner
            .get_authed(&format!("/servers/{}/channels", server_id))
            .await;
        let channels = body.as_array().expect("should be an array");
        assert_eq!(channels.len(), 0, "channel should be deleted");
    });
}

#[test]
fn test_delete_channel_non_owner_forbidden() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "chdelown", "chdelown@example.com").await;
        let member = register_client(srv, "chdelmem", "chdelmem@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "DelChAuth" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();
        let invite_code = server_body["invite_code"].as_str().unwrap();

        let (_, ch_body) = owner
            .post_authed(
                &format!("/servers/{}/channels", server_id),
                &json!({ "name": "protected", "encryption_mode": "standard" }),
            )
            .await;
        let channel_id = ch_body["id"].as_str().unwrap();

        member
            .post_authed("/servers/join", &json!({ "invite_code": invite_code }))
            .await;

        let status = member
            .delete_authed(&format!("/channels/{}", channel_id))
            .await;
        assert_eq!(status, 403, "non-owner should get 403 on delete channel");
    });
}

// ────────────────────────────────────────────────────────────
//  5c. Messages — send via WebSocket, receive, and history
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-009, WS-010
#[test]
fn test_message_send_and_receive() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "msgowner", "msgowner@example.com").await;
        let member = register_client(srv, "msgmember", "msgmember@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "MsgServer" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();
        let invite_code = server_body["invite_code"].as_str().unwrap();

        // Create a channel
        let (_, ch_body) = owner
            .post_authed(
                &format!("/servers/{}/channels", server_id),
                &json!({ "name": "chat", "encryption_mode": "standard" }),
            )
            .await;
        let channel_id = ch_body["id"].as_str().unwrap();

        // Member joins
        member
            .post_authed("/servers/join", &json!({ "invite_code": invite_code }))
            .await;

        // Connect both via WebSocket
        let owner_token = owner.access_token.as_ref().unwrap();
        let member_token = member.access_token.as_ref().unwrap();

        let mut ws_owner = srv.ws_client(owner_token).await;
        ws_owner.identify(owner_token, "dev-owner").await;
        // Drain presence events
        let _ = ws_owner
            .receive_json_timeout(Duration::from_millis(500))
            .await;

        let mut ws_member = srv.ws_client(member_token).await;
        ws_member.identify(member_token, "dev-member").await;
        // Drain presence events
        let _ = ws_member
            .receive_json_timeout(Duration::from_millis(500))
            .await;
        let _ = ws_member
            .receive_json_timeout(Duration::from_millis(500))
            .await;

        // Drain any remaining presence events on owner
        let _ = ws_owner
            .receive_json_timeout(Duration::from_millis(500))
            .await;

        // Owner sends a message
        ws_owner
            .send_json(&json!({
                "op": "message_send",
                "d": {
                    "channel_id": channel_id,
                    "content": "Hello from owner!"
                }
            }))
            .await;

        // Both should receive MESSAGE_CREATE
        let mut owner_got_msg = false;
        let mut member_got_msg = false;

        // MESSAGE_CREATE now arrives as binary (MessagePack) frames, use receive_any_timeout
        for _ in 0..5 {
            if let Some(msg) = ws_owner
                .receive_any_timeout(Duration::from_secs(3))
                .await
            {
                if msg["t"] == "MESSAGE_CREATE" {
                    assert_eq!(msg["d"]["content"], "Hello from owner!");
                    assert_eq!(msg["d"]["channel_id"], channel_id);
                    owner_got_msg = true;
                }
            }
            if owner_got_msg {
                break;
            }
        }

        for _ in 0..5 {
            if let Some(msg) = ws_member
                .receive_any_timeout(Duration::from_secs(3))
                .await
            {
                if msg["t"] == "MESSAGE_CREATE" {
                    assert_eq!(msg["d"]["content"], "Hello from owner!");
                    assert_eq!(msg["d"]["channel_id"], channel_id);
                    member_got_msg = true;
                }
            }
            if member_got_msg {
                break;
            }
        }

        assert!(owner_got_msg, "owner should receive MESSAGE_CREATE");
        assert!(member_got_msg, "member should receive MESSAGE_CREATE");

        ws_owner.close().await;
        ws_member.close().await;
    });
}

// TESTSPEC: API-035
#[test]
fn test_message_history_pagination() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "histowner", "histowner@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "HistServer" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();

        let (_, ch_body) = owner
            .post_authed(
                &format!("/servers/{}/channels", server_id),
                &json!({ "name": "history", "encryption_mode": "standard" }),
            )
            .await;
        let channel_id = ch_body["id"].as_str().unwrap();

        // Send multiple messages via WebSocket
        let token = owner.access_token.as_ref().unwrap();
        let mut ws = srv.ws_client(token).await;
        ws.identify(token, "dev-hist").await;
        let _ = ws.receive_json_timeout(Duration::from_millis(500)).await;

        for i in 0..5 {
            ws.send_json(&json!({
                "op": "message_send",
                "d": {
                    "channel_id": channel_id,
                    "content": format!("msg-{}", i)
                }
            }))
            .await;
            // Drain the MESSAGE_CREATE event
            let _ = ws.receive_json_timeout(Duration::from_secs(2)).await;
            // Small delay to ensure ordering
            sleep(Duration::from_millis(10)).await;
        }

        // Fetch all messages (no cursor)
        let (status, body) = owner
            .get_authed(&format!("/channels/{}/messages?limit=50", channel_id))
            .await;
        assert_eq!(status, 200);
        let messages = body.as_array().expect("should be an array");
        assert_eq!(messages.len(), 5, "should have 5 messages");

        // Fetch with limit
        let (status, body) = owner
            .get_authed(&format!("/channels/{}/messages?limit=2", channel_id))
            .await;
        assert_eq!(status, 200);
        let messages = body.as_array().expect("should be an array");
        assert_eq!(messages.len(), 2, "limit=2 should return 2 messages");

        // Cursor-based: use the ID of the oldest message in the first page to get older ones
        let first_msg_id = messages.last().unwrap()["id"].as_str().unwrap();
        let (status, body) = owner
            .get_authed(&format!(
                "/channels/{}/messages?before={}&limit=10",
                channel_id, first_msg_id
            ))
            .await;
        assert_eq!(status, 200);
        let older = body.as_array().expect("should be an array");
        assert_eq!(older.len(), 3, "should have 3 older messages");

        ws.close().await;
    });
}

// TESTSPEC: API-037
#[test]
fn test_message_history_requires_membership() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "histauth", "histauth@example.com").await;
        let outsider = register_client(srv, "histout", "histout@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "HistAuth" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();

        let (_, ch_body) = owner
            .post_authed(
                &format!("/servers/{}/channels", server_id),
                &json!({ "name": "restricted", "encryption_mode": "standard" }),
            )
            .await;
        let channel_id = ch_body["id"].as_str().unwrap();

        let (status, _) = outsider
            .get_authed(&format!("/channels/{}/messages", channel_id))
            .await;
        assert_eq!(status, 403, "non-member should get 403 on message history");
    });
}

// ────────────────────────────────────────────────────────────
//  5d. READY payload includes servers and channels
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-031
#[test]
fn test_ready_includes_servers_and_channels() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "readyowner", "readyowner@example.com").await;

        // Create a server and channel
        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "ReadyServer" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();

        owner
            .post_authed(
                &format!("/servers/{}/channels", server_id),
                &json!({ "name": "general", "encryption_mode": "standard" }),
            )
            .await;

        // Connect via WebSocket and check READY
        let token = owner.access_token.as_ref().unwrap();
        let mut ws = srv.ws_client(token).await;
        let ready = ws.identify(token, "dev-ready").await;

        let servers = ready["d"]["servers"].as_array().expect("servers should be array");
        assert_eq!(servers.len(), 1, "READY should include 1 server");
        assert_eq!(servers[0]["id"], server_id);
        assert_eq!(servers[0]["name"], "ReadyServer");

        let channels = ready["d"]["channels"]
            .as_array()
            .expect("channels should be array");
        assert_eq!(channels.len(), 1, "READY should include 1 channel");
        assert_eq!(channels[0]["name"], "general");

        ws.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  5e. MEMBER_ADD and MEMBER_REMOVE events
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-023
#[test]
fn test_member_add_event_on_join() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "maddowner", "maddowner@example.com").await;
        let joiner = register_client(srv, "maddjoiner", "maddjoiner@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "EventServer" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();
        let invite_code = server_body["invite_code"].as_str().unwrap();

        // Owner connects to WS
        let owner_token = owner.access_token.as_ref().unwrap();
        let mut ws_owner = srv.ws_client(owner_token).await;
        ws_owner.identify(owner_token, "dev-owner").await;
        let _ = ws_owner
            .receive_json_timeout(Duration::from_millis(500))
            .await;

        // Joiner joins the server via REST
        joiner
            .post_authed("/servers/join", &json!({ "invite_code": invite_code }))
            .await;

        // Owner should receive MEMBER_ADD
        let mut saw_member_add = false;
        for _ in 0..5 {
            if let Some(msg) = ws_owner
                .receive_json_timeout(Duration::from_secs(3))
                .await
            {
                if msg["t"] == "MEMBER_ADD" {
                    assert_eq!(msg["d"]["server_id"], server_id);
                    assert_eq!(
                        msg["d"]["user_id"],
                        joiner.user_id.as_ref().unwrap().as_str()
                    );
                    saw_member_add = true;
                    break;
                }
            }
        }
        assert!(saw_member_add, "owner should receive MEMBER_ADD event");

        ws_owner.close().await;
    });
}

// TESTSPEC: WS-024
#[test]
fn test_member_remove_event_on_leave() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let owner = register_client(srv, "mremowner", "mremowner@example.com").await;
        let leaver = register_client(srv, "mremleaver", "mremleaver@example.com").await;

        let (_, server_body) = owner
            .post_authed("/servers", &json!({ "name": "LeaveEvent" }))
            .await;
        let server_id = server_body["id"].as_str().unwrap();
        let invite_code = server_body["invite_code"].as_str().unwrap();

        leaver
            .post_authed("/servers/join", &json!({ "invite_code": invite_code }))
            .await;

        // Owner connects to WS
        let owner_token = owner.access_token.as_ref().unwrap();
        let mut ws_owner = srv.ws_client(owner_token).await;
        ws_owner.identify(owner_token, "dev-owner").await;
        let _ = ws_owner
            .receive_json_timeout(Duration::from_millis(500))
            .await;

        // Leaver leaves
        leaver
            .delete_authed(&format!("/servers/{}/members/me", server_id))
            .await;

        // Owner should receive MEMBER_REMOVE
        let mut saw_member_remove = false;
        for _ in 0..5 {
            if let Some(msg) = ws_owner
                .receive_json_timeout(Duration::from_secs(3))
                .await
            {
                if msg["t"] == "MEMBER_REMOVE" {
                    assert_eq!(msg["d"]["server_id"], server_id);
                    assert_eq!(
                        msg["d"]["user_id"],
                        leaver.user_id.as_ref().unwrap().as_str()
                    );
                    saw_member_remove = true;
                    break;
                }
            }
        }
        assert!(
            saw_member_remove,
            "owner should receive MEMBER_REMOVE event"
        );

        ws_owner.close().await;
    });
}
