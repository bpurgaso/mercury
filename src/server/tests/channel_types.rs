mod common;

use common::{setup, TestServer};
use serde_json::json;
use std::sync::OnceLock;

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
    SERVER.get_or_init(|| runtime().block_on(TestServer::start_with_auth_rate_limit(100)))
}

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

/// Helper: register a user, create a server, return (client, server_id).
async fn setup_server(srv: &TestServer, prefix: &str) -> (common::TestClient, String) {
    let owner = register_client(srv, prefix, &format!("{prefix}@example.com")).await;
    let (status, body) = owner
        .post_authed("/servers", &json!({ "name": format!("{prefix}-server") }))
        .await;
    assert_eq!(status, 201);
    let server_id = body["id"].as_str().unwrap().to_string();
    (owner, server_id)
}

// ────────────────────────────────────────────────────────────
//  Channel type creation tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_create_text_channel_explicit() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (owner, server_id) = setup_server(srv, "txtexpl").await;

        let (status, body) = owner
            .post_authed(
                &format!("/servers/{server_id}/channels"),
                &json!({
                    "name": "general",
                    "channel_type": "text",
                    "encryption_mode": "standard"
                }),
            )
            .await;

        assert_eq!(status, 201, "create text channel should return 201");
        assert_eq!(body["name"], "general");
        assert_eq!(body["channel_type"], "text");
        assert_eq!(body["encryption_mode"], "standard");
        assert_eq!(body["server_id"], server_id);
    });
}

#[test]
fn test_create_text_channel_default() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (owner, server_id) = setup_server(srv, "txtdef").await;

        // Omit channel_type — should default to "text"
        let (status, body) = owner
            .post_authed(
                &format!("/servers/{server_id}/channels"),
                &json!({
                    "name": "default-type",
                    "encryption_mode": "standard"
                }),
            )
            .await;

        assert_eq!(status, 201, "create channel without type should return 201");
        assert_eq!(body["channel_type"], "text", "default channel_type should be text");
    });
}

#[test]
fn test_create_voice_channel() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (owner, server_id) = setup_server(srv, "voice").await;

        let (status, body) = owner
            .post_authed(
                &format!("/servers/{server_id}/channels"),
                &json!({
                    "name": "voice-chat",
                    "channel_type": "voice",
                    "encryption_mode": "standard"
                }),
            )
            .await;

        assert_eq!(status, 201, "create voice channel should return 201");
        assert_eq!(body["name"], "voice-chat");
        assert_eq!(body["channel_type"], "voice");
        assert_eq!(body["encryption_mode"], "standard");
        assert_eq!(body["server_id"], server_id);
    });
}

#[test]
fn test_create_video_channel() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (owner, server_id) = setup_server(srv, "video").await;

        let (status, body) = owner
            .post_authed(
                &format!("/servers/{server_id}/channels"),
                &json!({
                    "name": "video-room",
                    "channel_type": "video",
                    "encryption_mode": "standard"
                }),
            )
            .await;

        assert_eq!(status, 201, "create video channel should return 201");
        assert_eq!(body["name"], "video-room");
        assert_eq!(body["channel_type"], "video");
        assert_eq!(body["encryption_mode"], "standard");
        assert_eq!(body["server_id"], server_id);
    });
}

#[test]
fn test_create_voice_channel_private() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (owner, server_id) = setup_server(srv, "voicepriv").await;

        let (status, body) = owner
            .post_authed(
                &format!("/servers/{server_id}/channels"),
                &json!({
                    "name": "private-voice",
                    "channel_type": "voice",
                    "encryption_mode": "private"
                }),
            )
            .await;

        assert_eq!(status, 201, "create private voice channel should return 201");
        assert_eq!(body["channel_type"], "voice");
        assert_eq!(body["encryption_mode"], "private");
    });
}

#[test]
fn test_create_channel_invalid_type() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (owner, server_id) = setup_server(srv, "badtype").await;

        let (status, _) = owner
            .post_authed(
                &format!("/servers/{server_id}/channels"),
                &json!({
                    "name": "bad",
                    "channel_type": "screenshare",
                    "encryption_mode": "standard"
                }),
            )
            .await;

        assert_eq!(status, 400, "invalid channel_type should return 400");
    });
}

// ────────────────────────────────────────────────────────────
//  Listing channels preserves channel_type
// ────────────────────────────────────────────────────────────

#[test]
fn test_list_channels_returns_correct_types() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (owner, server_id) = setup_server(srv, "listtype").await;

        // Create one of each type
        owner
            .post_authed(
                &format!("/servers/{server_id}/channels"),
                &json!({
                    "name": "general",
                    "channel_type": "text",
                    "encryption_mode": "standard"
                }),
            )
            .await;
        owner
            .post_authed(
                &format!("/servers/{server_id}/channels"),
                &json!({
                    "name": "voice-chat",
                    "channel_type": "voice",
                    "encryption_mode": "standard"
                }),
            )
            .await;
        owner
            .post_authed(
                &format!("/servers/{server_id}/channels"),
                &json!({
                    "name": "video-room",
                    "channel_type": "video",
                    "encryption_mode": "standard"
                }),
            )
            .await;

        let (status, body) = owner
            .get_authed(&format!("/servers/{server_id}/channels"))
            .await;
        assert_eq!(status, 200);

        let channels = body.as_array().expect("should be an array");
        assert_eq!(channels.len(), 3, "should have 3 channels");

        let text_channels: Vec<_> = channels
            .iter()
            .filter(|c| c["channel_type"] == "text")
            .collect();
        let voice_channels: Vec<_> = channels
            .iter()
            .filter(|c| c["channel_type"] == "voice")
            .collect();
        let video_channels: Vec<_> = channels
            .iter()
            .filter(|c| c["channel_type"] == "video")
            .collect();

        assert_eq!(text_channels.len(), 1, "should have 1 text channel");
        assert_eq!(voice_channels.len(), 1, "should have 1 voice channel");
        assert_eq!(video_channels.len(), 1, "should have 1 video channel");

        assert_eq!(text_channels[0]["name"], "general");
        assert_eq!(voice_channels[0]["name"], "voice-chat");
        assert_eq!(video_channels[0]["name"], "video-room");
    });
}

// ────────────────────────────────────────────────────────────
//  Channel type persists through CHANNEL_CREATE WS event
// ────────────────────────────────────────────────────────────

#[test]
fn test_channel_create_event_includes_type() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let (owner, server_id) = setup_server(srv, "wstype").await;

        let token = owner.access_token.as_ref().unwrap();
        let mut ws = srv.ws_client(token).await;
        ws.identify(token, "dev-wstype").await;
        // Drain any initial events
        let _ = ws
            .receive_json_timeout(std::time::Duration::from_millis(500))
            .await;

        // Create a voice channel via REST
        owner
            .post_authed(
                &format!("/servers/{server_id}/channels"),
                &json!({
                    "name": "ws-voice",
                    "channel_type": "voice",
                    "encryption_mode": "standard"
                }),
            )
            .await;

        // WS should receive CHANNEL_CREATE with channel_type
        let mut saw_event = false;
        for _ in 0..5 {
            if let Some(msg) = ws
                .receive_json_timeout(std::time::Duration::from_secs(3))
                .await
            {
                if msg["t"] == "CHANNEL_CREATE" {
                    assert_eq!(msg["d"]["name"], "ws-voice");
                    assert_eq!(msg["d"]["channel_type"], "voice");
                    saw_event = true;
                    break;
                }
            }
        }
        assert!(saw_event, "should receive CHANNEL_CREATE with channel_type voice");

        ws.close().await;
    });
}
