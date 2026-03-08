// Phase 8 — SFU Media Engine & Call Signaling integration tests.
//  Tests MUST run sequentially (`--test-threads=1` / `nextest -j 1`)
//  because they share a single server and truncate tables between tests.
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

/// Server with high auth rate limit for tests that register many users.
fn server_high_rate() -> &'static TestServer {
    static SERVER: OnceLock<TestServer> = OnceLock::new();
    SERVER.get_or_init(|| runtime().block_on(TestServer::start_with_auth_rate_limit(200)))
}

// ────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────

async fn register_user(srv: &TestServer, username: &str, email: &str) -> (String, String) {
    let mut client = srv.client();
    let (status, _) = client.register_raw(username, email, "password123").await;
    assert_eq!(status, 201, "registration should succeed for {username}");
    (client.access_token.unwrap(), client.user_id.unwrap())
}

async fn create_server_helper(srv: &TestServer, token: &str, name: &str) -> (String, String) {
    let resp = reqwest::Client::new()
        .post(format!("{}/servers", srv.base_url()))
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({ "name": name }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    (
        body["id"].as_str().unwrap().to_string(),
        body["invite_code"].as_str().unwrap().to_string(),
    )
}

async fn create_voice_channel(
    srv: &TestServer,
    token: &str,
    server_id: &str,
    name: &str,
) -> String {
    let resp = reqwest::Client::new()
        .post(format!("{}/servers/{}/channels", srv.base_url(), server_id))
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({
            "name": name,
            "channel_type": "voice",
            "encryption_mode": "standard",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201, "voice channel creation should succeed");
    let body: Value = resp.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

async fn join_server_helper(srv: &TestServer, token: &str, invite_code: &str) {
    let resp = reqwest::Client::new()
        .post(format!("{}/servers/join", srv.base_url()))
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({ "invite_code": invite_code }))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
}

/// Connect WS, identify, and return the ws client + READY payload.
async fn ws_identify(
    srv: &TestServer,
    token: &str,
    device_id: &str,
) -> common::TestWsClient {
    let mut ws = srv.ws_client(token).await;
    let _ready = ws.identify(token, device_id).await;
    ws
}

/// Drain events of a specific type from a WS client.
async fn drain_events(ws: &mut common::TestWsClient, event_type: &str) -> Vec<Value> {
    ws.collect_events(event_type, Duration::from_millis(500)).await
}

/// Minimal valid SDP offer that str0m can parse for testing.
fn test_sdp_offer() -> String {
    [
        "v=0",
        "o=- 0 0 IN IP4 127.0.0.1",
        "s=-",
        "t=0 0",
        "a=group:BUNDLE 0",
        "a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
        "a=setup:actpass",
        "a=ice-lite",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
        "c=IN IP4 0.0.0.0",
        "a=mid:0",
        "a=sendrecv",
        "a=rtpmap:111 opus/48000/2",
        "a=ice-ufrag:testufrag",
        "a=ice-pwd:testpassword1234567890123456",
    ]
    .join("\r\n")
        + "\r\n"
}

// ────────────────────────────────────────────────────────────
//  Test 1: voice_state_update join → VOICE_STATE_UPDATE broadcast + CALL_STARTED
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-015
#[test]
fn test_voice_state_update_join() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        // Register two users, create a server, both join
        let (token_a, user_a) = register_user(srv, "alice", "alice@test.com").await;
        let (token_b, _user_b) = register_user(srv, "bob", "bob@test.com").await;
        let (server_id, invite_code) = create_server_helper(srv, &token_a, "VoiceServer").await;
        join_server_helper(srv, &token_b, &invite_code).await;
        let channel_id = create_voice_channel(srv, &token_a, &server_id, "General Voice").await;

        // Both connect to WebSocket
        let mut ws_a = ws_identify(srv, &token_a, "device-a").await;
        let mut ws_b = ws_identify(srv, &token_b, "device-b").await;

        // Drain any initial events (CHANNEL_CREATE etc)
        sleep(Duration::from_millis(200)).await;
        let _ = drain_events(&mut ws_a, "").await;
        let _ = drain_events(&mut ws_b, "").await;

        // Alice joins voice channel
        ws_a.send_json(&json!({
            "op": "voice_state_update",
            "d": {
                "channel_id": channel_id,
                "self_mute": false,
                "self_deaf": false
            }
        }))
        .await;

        // Alice should receive CALL_CONFIG (skip unrelated events like PRESENCE_UPDATE)
        let mut got_call_config = false;
        for _ in 0..5 {
            if let Some(msg) = ws_a.receive_json_timeout(Duration::from_secs(3)).await {
                if msg["t"] == "CALL_CONFIG" {
                    assert!(!msg["d"]["room_id"].as_str().unwrap().is_empty());
                    got_call_config = true;
                    break;
                }
            } else {
                break;
            }
        }
        assert!(got_call_config, "alice should receive CALL_CONFIG");

        // Bob should receive CALL_STARTED and VOICE_STATE_UPDATE
        sleep(Duration::from_millis(300)).await;
        let mut got_call_started = false;
        let mut got_voice_state = false;
        for _ in 0..10 {
            if let Some(msg) = ws_b.receive_json_timeout(Duration::from_secs(2)).await {
                match msg["t"].as_str() {
                    Some("CALL_STARTED") => {
                        assert_eq!(msg["d"]["channel_id"], channel_id);
                        assert_eq!(msg["d"]["initiator_id"], user_a);
                        got_call_started = true;
                    }
                    Some("VOICE_STATE_UPDATE") => {
                        if msg["d"]["user_id"] == user_a && msg["d"]["channel_id"] == channel_id {
                            got_voice_state = true;
                        }
                    }
                    _ => {}
                }
                if got_call_started && got_voice_state {
                    break;
                }
            } else {
                break;
            }
        }
        assert!(got_call_started, "bob should receive CALL_STARTED");
        assert!(got_voice_state, "bob should receive VOICE_STATE_UPDATE for alice joining");

        ws_a.close().await;
        ws_b.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  Test 2: voice_state_update leave → VOICE_STATE_UPDATE + CALL_ENDED
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-015
#[test]
fn test_voice_state_update_leave() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, user_a) = register_user(srv, "alice", "alice@test.com").await;
        let (token_b, _user_b) = register_user(srv, "bob", "bob@test.com").await;
        let (server_id, invite_code) = create_server_helper(srv, &token_a, "VoiceServer").await;
        join_server_helper(srv, &token_b, &invite_code).await;
        let channel_id = create_voice_channel(srv, &token_a, &server_id, "Voice").await;

        let mut ws_a = ws_identify(srv, &token_a, "device-a").await;
        let mut ws_b = ws_identify(srv, &token_b, "device-b").await;

        // Drain initial events
        sleep(Duration::from_millis(200)).await;
        let _ = drain_events(&mut ws_a, "").await;
        let _ = drain_events(&mut ws_b, "").await;

        // Alice joins
        ws_a.send_json(&json!({
            "op": "voice_state_update",
            "d": { "channel_id": channel_id, "self_mute": false, "self_deaf": false }
        })).await;

        // Wait for CALL_CONFIG
        let _ = ws_a.receive_json_timeout(Duration::from_secs(2)).await;
        sleep(Duration::from_millis(300)).await;
        // Drain Bob's events
        let _ = drain_events(&mut ws_b, "").await;

        // Alice leaves (channel_id = null)
        ws_a.send_json(&json!({
            "op": "voice_state_update",
            "d": { "channel_id": null, "self_mute": false, "self_deaf": false }
        })).await;

        sleep(Duration::from_millis(500)).await;

        // Bob should receive VOICE_STATE_UPDATE (leave) and CALL_ENDED
        let mut got_leave = false;
        let mut got_call_ended = false;
        for _ in 0..5 {
            if let Some(msg) = ws_b.receive_json_timeout(Duration::from_secs(2)).await {
                match msg["t"].as_str() {
                    Some("VOICE_STATE_UPDATE") => {
                        if msg["d"]["user_id"] == user_a && msg["d"]["channel_id"].is_null() {
                            got_leave = true;
                        }
                    }
                    Some("CALL_ENDED") => {
                        got_call_ended = true;
                    }
                    _ => {}
                }
                if got_leave && got_call_ended {
                    break;
                }
            } else {
                break;
            }
        }
        assert!(got_leave, "bob should receive leave VOICE_STATE_UPDATE");
        assert!(got_call_ended, "bob should receive CALL_ENDED");

        ws_a.close().await;
        ws_b.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  Test 3: webrtc_signal relay — SDP offer → str0m SDP answer
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-016
#[test]
fn test_webrtc_signal_sdp_relay() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _user_a) = register_user(srv, "alice", "alice@test.com").await;
        let (server_id, _invite) = create_server_helper(srv, &token_a, "SignalServer").await;
        let channel_id = create_voice_channel(srv, &token_a, &server_id, "Voice").await;

        let mut ws_a = ws_identify(srv, &token_a, "device-a").await;
        sleep(Duration::from_millis(200)).await;
        let _ = drain_events(&mut ws_a, "").await;

        // Join voice channel
        ws_a.send_json(&json!({
            "op": "voice_state_update",
            "d": { "channel_id": channel_id, "self_mute": false, "self_deaf": false }
        })).await;

        // Get CALL_CONFIG to extract room_id
        let config_msg = ws_a
            .receive_json_timeout(Duration::from_secs(2))
            .await
            .expect("should receive CALL_CONFIG");
        let room_id = config_msg["d"]["room_id"].as_str().unwrap().to_string();

        // Drain remaining events
        sleep(Duration::from_millis(300)).await;
        let _ = drain_events(&mut ws_a, "").await;

        // Send a valid SDP offer that str0m can parse
        ws_a.send_json(&json!({
            "op": "webrtc_signal",
            "d": {
                "room_id": room_id,
                "signal": {
                    "type": "offer",
                    "sdp": test_sdp_offer()
                }
            }
        })).await;

        // Should receive WEBRTC_SIGNAL with a real str0m-generated SDP answer
        let answer_msg = ws_a
            .receive_json_timeout(Duration::from_secs(3))
            .await
            .expect("should receive WEBRTC_SIGNAL with answer");
        assert_eq!(answer_msg["t"], "WEBRTC_SIGNAL");
        assert_eq!(answer_msg["d"]["signal"]["type"], "answer");

        // Validate the SDP answer is a proper WebRTC SDP (not a placeholder)
        let answer_sdp = answer_msg["d"]["signal"]["sdp"].as_str().unwrap();
        assert!(answer_sdp.contains("v=0"), "answer should contain SDP version");
        assert!(answer_sdp.contains("m=audio"), "answer should contain audio media line");
        assert!(answer_sdp.contains("a=ice-ufrag"), "answer should contain ICE credentials");
        assert!(answer_sdp.contains("a=ice-pwd"), "answer should contain ICE password");
        assert!(answer_sdp.contains("a=fingerprint"), "answer should contain DTLS fingerprint");

        ws_a.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  Test 4: ICE candidate relay
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-016
#[test]
fn test_ice_candidate_relay() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _user_a) = register_user(srv, "alice", "alice@test.com").await;
        let (token_b, _user_b) = register_user(srv, "bob", "bob@test.com").await;
        let (server_id, invite_code) = create_server_helper(srv, &token_a, "ICEServer").await;
        join_server_helper(srv, &token_b, &invite_code).await;
        let channel_id = create_voice_channel(srv, &token_a, &server_id, "Voice").await;

        let mut ws_a = ws_identify(srv, &token_a, "device-a").await;
        let mut ws_b = ws_identify(srv, &token_b, "device-b").await;
        sleep(Duration::from_millis(200)).await;
        let _ = drain_events(&mut ws_a, "").await;
        let _ = drain_events(&mut ws_b, "").await;

        // Both join voice channel
        ws_a.send_json(&json!({
            "op": "voice_state_update",
            "d": { "channel_id": channel_id, "self_mute": false, "self_deaf": false }
        })).await;
        let config_a = ws_a.receive_json_timeout(Duration::from_secs(2)).await.unwrap();
        let room_id = config_a["d"]["room_id"].as_str().unwrap().to_string();

        sleep(Duration::from_millis(200)).await;
        let _ = drain_events(&mut ws_b, "").await;

        ws_b.send_json(&json!({
            "op": "voice_state_update",
            "d": { "channel_id": channel_id, "self_mute": false, "self_deaf": false }
        })).await;
        let _ = ws_b.receive_json_timeout(Duration::from_secs(2)).await;

        sleep(Duration::from_millis(300)).await;
        let _ = drain_events(&mut ws_a, "").await;
        let _ = drain_events(&mut ws_b, "").await;

        // Alice sends ICE candidate — str0m will process it (no relay to other peers
        // since ICE goes through the SFU, not peer-to-peer). The signal should not error.
        ws_a.send_json(&json!({
            "op": "webrtc_signal",
            "d": {
                "room_id": room_id,
                "signal": {
                    "type": "ice_candidate",
                    "candidate": "candidate:1 1 UDP 2130706431 192.168.1.1 5000 typ host"
                }
            }
        })).await;

        // No error should be received (ICE candidates are processed by str0m, not relayed)
        sleep(Duration::from_millis(300)).await;
        let events = drain_events(&mut ws_a, "ERROR").await;
        assert!(events.is_empty(), "should not receive errors for ICE candidate");

        ws_a.close().await;
        ws_b.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  Test 5: CALL_CONFIG includes TURN credentials and simulcast
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-017
// TESTSPEC: MEDIA-004
#[test]
fn test_call_config_turn_credentials() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, user_a) = register_user(srv, "alice", "alice@test.com").await;
        let (server_id, _invite) = create_server_helper(srv, &token_a, "TurnServer").await;
        let channel_id = create_voice_channel(srv, &token_a, &server_id, "Voice").await;

        let mut ws_a = ws_identify(srv, &token_a, "device-a").await;
        sleep(Duration::from_millis(200)).await;
        let _ = drain_events(&mut ws_a, "").await;

        // Join voice channel
        ws_a.send_json(&json!({
            "op": "voice_state_update",
            "d": { "channel_id": channel_id, "self_mute": false, "self_deaf": false }
        })).await;

        let config_msg = ws_a
            .receive_json_timeout(Duration::from_secs(2))
            .await
            .expect("should receive CALL_CONFIG");
        assert_eq!(config_msg["t"], "CALL_CONFIG");
        let d = &config_msg["d"];

        // Verify room_id
        assert!(!d["room_id"].as_str().unwrap().is_empty());

        // Verify TURN credentials
        let username = d["username"].as_str().unwrap();
        let credential = d["credential"].as_str().unwrap();
        let ttl = d["ttl"].as_u64().unwrap();

        // Username format: {timestamp}:{user_id}
        assert!(username.contains(':'), "username should contain :");
        let parts: Vec<&str> = username.split(':').collect();
        assert_eq!(parts.len(), 2);
        let _timestamp: u64 = parts[0].parse().expect("timestamp should be a number");
        assert_eq!(parts[1], user_a);

        // Verify HMAC
        assert!(
            mercury_auth::turn::verify_turn_credential(username, credential, "test-turn-secret"),
            "TURN credential should verify with test secret"
        );

        // TTL
        assert_eq!(ttl, 86400);

        // TURN/STUN URLs
        let turn_urls = d["turn_urls"].as_array().unwrap();
        assert!(!turn_urls.is_empty());
        let stun_urls = d["stun_urls"].as_array().unwrap();
        assert!(!stun_urls.is_empty());

        // Audio limits
        assert_eq!(d["audio"]["max_bitrate_kbps"], 128);
        assert_eq!(d["audio"]["preferred_bitrate_kbps"], 64);

        // Video limits
        assert_eq!(d["video"]["max_bitrate_kbps"], 2500);
        assert_eq!(d["video"]["max_resolution"], "1280x720");
        assert_eq!(d["video"]["max_framerate"], 30);

        // Simulcast config
        assert_eq!(d["video"]["simulcast_enabled"], true);
        let layers = d["video"]["simulcast_layers"].as_array().unwrap();
        assert_eq!(layers.len(), 3);
        assert_eq!(layers[0]["rid"], "h");
        assert_eq!(layers[1]["rid"], "m");
        assert_eq!(layers[2]["rid"], "l");

        ws_a.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  Test 6: POST /calls — creates room, returns call info
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-017
// TESTSPEC: MEDIA-001
#[test]
fn test_post_calls() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _user_a) = register_user(srv, "alice", "alice@test.com").await;
        let (server_id, _invite) = create_server_helper(srv, &token_a, "CallServer").await;
        let channel_id = create_voice_channel(srv, &token_a, &server_id, "Voice").await;

        let resp = reqwest::Client::new()
            .post(format!("{}/calls", srv.base_url()))
            .header("Authorization", format!("Bearer {token_a}"))
            .json(&json!({ "channel_id": channel_id }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        let body: Value = resp.json().await.unwrap();
        assert!(!body["room_id"].as_str().unwrap().is_empty());
        assert_eq!(body["channel_id"], channel_id);
        assert!(body["participants"].as_array().unwrap().len() >= 1);
        assert!(body["call_config"].is_object());

        // Verify call_config has TURN credentials and simulcast
        let cc = &body["call_config"];
        assert!(!cc["username"].as_str().unwrap().is_empty());
        assert!(!cc["credential"].as_str().unwrap().is_empty());
        assert_eq!(cc["ttl"], 86400);
        assert_eq!(cc["video"]["simulcast_enabled"], true);
    });
}

// ────────────────────────────────────────────────────────────
//  Test 7: GET /calls/:id — returns participants and status
// ────────────────────────────────────────────────────────────

// TESTSPEC: MEDIA-001
// TESTSPEC: MEDIA-002
#[test]
fn test_get_call() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, user_a) = register_user(srv, "alice", "alice@test.com").await;
        let (server_id, _invite) = create_server_helper(srv, &token_a, "CallServer").await;
        let channel_id = create_voice_channel(srv, &token_a, &server_id, "Voice").await;

        // Create a call via POST
        let resp = reqwest::Client::new()
            .post(format!("{}/calls", srv.base_url()))
            .header("Authorization", format!("Bearer {token_a}"))
            .json(&json!({ "channel_id": channel_id }))
            .send()
            .await
            .unwrap();
        let body: Value = resp.json().await.unwrap();
        let room_id = body["room_id"].as_str().unwrap();

        // GET the call
        let resp = reqwest::Client::new()
            .get(format!("{}/calls/{}", srv.base_url(), room_id))
            .header("Authorization", format!("Bearer {token_a}"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        let body: Value = resp.json().await.unwrap();
        assert_eq!(body["room_id"], room_id);
        assert_eq!(body["channel_id"], channel_id);
        assert!(body["started_at"].as_str().is_some());
        let participants = body["participants"].as_array().unwrap();
        assert_eq!(participants.len(), 1);
        assert_eq!(participants[0]["user_id"], user_a);
    });
}

// ────────────────────────────────────────────────────────────
//  Test 8: Max participants — 26th participant rejected
// ────────────────────────────────────────────────────────────

// TESTSPEC: MEDIA-003
#[test]
fn test_max_participants_rejected() {
    let srv = server_high_rate();
    runtime().block_on(async {
        setup(srv).await;

        let (token_owner, _) = register_user(srv, "owner", "owner@test.com").await;
        let (server_id, invite_code) =
            create_server_helper(srv, &token_owner, "FullServer").await;
        let channel_id = create_voice_channel(srv, &token_owner, &server_id, "Voice").await;

        // Owner joins via POST /calls
        let resp = reqwest::Client::new()
            .post(format!("{}/calls", srv.base_url()))
            .header("Authorization", format!("Bearer {token_owner}"))
            .json(&json!({ "channel_id": channel_id }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        // Register and join 24 more users (total 25 = max)
        for i in 1..=24 {
            let (token, _) = register_user(
                srv,
                &format!("user{i}"),
                &format!("user{i}@test.com"),
            )
            .await;
            join_server_helper(srv, &token, &invite_code).await;

            let resp = reqwest::Client::new()
                .post(format!("{}/calls", srv.base_url()))
                .header("Authorization", format!("Bearer {token}"))
                .json(&json!({ "channel_id": channel_id }))
                .send()
                .await
                .unwrap();
            assert_eq!(
                resp.status(),
                200,
                "user{i} should be able to join (total {})",
                i + 1
            );
        }

        // 26th user should be rejected
        let (token_26, _) = register_user(srv, "user26", "user26@test.com").await;
        join_server_helper(srv, &token_26, &invite_code).await;

        let resp = reqwest::Client::new()
            .post(format!("{}/calls", srv.base_url()))
            .header("Authorization", format!("Bearer {token_26}"))
            .json(&json!({ "channel_id": channel_id }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 400, "26th participant should be rejected");
        let body: Value = resp.json().await.unwrap();
        assert!(
            body["error"].as_str().unwrap().contains("full"),
            "error should mention room is full"
        );
    });
}

// ────────────────────────────────────────────────────────────
//  Test 9: Non-member cannot join voice channel
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-020
#[test]
fn test_non_member_cannot_join() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _) = register_user(srv, "alice", "alice@test.com").await;
        let (token_b, _) = register_user(srv, "bob", "bob@test.com").await;
        let (server_id, _invite) = create_server_helper(srv, &token_a, "PrivateServer").await;
        let channel_id = create_voice_channel(srv, &token_a, &server_id, "Voice").await;

        // Bob (not a member) tries to join via WebSocket
        let mut ws_b = ws_identify(srv, &token_b, "device-b").await;
        sleep(Duration::from_millis(200)).await;
        let _ = drain_events(&mut ws_b, "").await;

        ws_b.send_json(&json!({
            "op": "voice_state_update",
            "d": { "channel_id": channel_id, "self_mute": false, "self_deaf": false }
        })).await;

        // Bob should receive an ERROR
        let error_msg = ws_b
            .receive_json_timeout(Duration::from_secs(2))
            .await
            .expect("bob should receive an error");
        assert_eq!(error_msg["t"], "ERROR");
        assert_eq!(error_msg["d"]["code"], "FORBIDDEN");

        // Bob also cannot join via REST
        let resp = reqwest::Client::new()
            .post(format!("{}/calls", srv.base_url()))
            .header("Authorization", format!("Bearer {token_b}"))
            .json(&json!({ "channel_id": channel_id }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 403);

        ws_b.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  Test 10: Room cleanup — all leave → room destroyed
// ────────────────────────────────────────────────────────────

// TESTSPEC: MEDIA-001
#[test]
fn test_room_cleanup() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _) = register_user(srv, "alice", "alice@test.com").await;
        let (server_id, _invite) = create_server_helper(srv, &token_a, "CleanupServer").await;
        let channel_id = create_voice_channel(srv, &token_a, &server_id, "Voice").await;

        // Create a call
        let resp = reqwest::Client::new()
            .post(format!("{}/calls", srv.base_url()))
            .header("Authorization", format!("Bearer {token_a}"))
            .json(&json!({ "channel_id": channel_id }))
            .send()
            .await
            .unwrap();
        let body: Value = resp.json().await.unwrap();
        let room_id = body["room_id"].as_str().unwrap().to_string();

        // Verify room exists
        let resp = reqwest::Client::new()
            .get(format!("{}/calls/{}", srv.base_url(), room_id))
            .header("Authorization", format!("Bearer {token_a}"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        // Leave via WebSocket voice_state_update with channel_id = null
        let mut ws_a = ws_identify(srv, &token_a, "device-a").await;
        sleep(Duration::from_millis(200)).await;
        let _ = drain_events(&mut ws_a, "").await;

        ws_a.send_json(&json!({
            "op": "voice_state_update",
            "d": { "channel_id": null, "self_mute": false, "self_deaf": false }
        })).await;

        sleep(Duration::from_millis(500)).await;

        // Room should now be destroyed — GET returns 404
        let resp = reqwest::Client::new()
            .get(format!("{}/calls/{}", srv.base_url(), room_id))
            .header("Authorization", format!("Bearer {token_a}"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404, "room should be destroyed after all leave");

        ws_a.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  Test 11: Multiple rooms — two channels, independent calls
// ────────────────────────────────────────────────────────────

// TESTSPEC: MEDIA-001
// TESTSPEC: MEDIA-002
#[test]
fn test_multiple_rooms() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, user_a) = register_user(srv, "alice", "alice@test.com").await;
        let (token_b, user_b) = register_user(srv, "bob", "bob@test.com").await;
        let (server_id, invite_code) = create_server_helper(srv, &token_a, "MultiServer").await;
        join_server_helper(srv, &token_b, &invite_code).await;

        let channel_1 = create_voice_channel(srv, &token_a, &server_id, "Voice 1").await;
        let channel_2 = create_voice_channel(srv, &token_a, &server_id, "Voice 2").await;

        // Alice joins channel 1
        let resp = reqwest::Client::new()
            .post(format!("{}/calls", srv.base_url()))
            .header("Authorization", format!("Bearer {token_a}"))
            .json(&json!({ "channel_id": channel_1 }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body_1: Value = resp.json().await.unwrap();
        let room_1 = body_1["room_id"].as_str().unwrap().to_string();

        // Bob joins channel 2
        let resp = reqwest::Client::new()
            .post(format!("{}/calls", srv.base_url()))
            .header("Authorization", format!("Bearer {token_b}"))
            .json(&json!({ "channel_id": channel_2 }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body_2: Value = resp.json().await.unwrap();
        let room_2 = body_2["room_id"].as_str().unwrap().to_string();

        // Rooms should be different
        assert_ne!(room_1, room_2, "rooms should be independent");

        // Each room should have exactly 1 participant
        let resp = reqwest::Client::new()
            .get(format!("{}/calls/{}", srv.base_url(), room_1))
            .header("Authorization", format!("Bearer {token_a}"))
            .send()
            .await
            .unwrap();
        let body: Value = resp.json().await.unwrap();
        let participants_1 = body["participants"].as_array().unwrap();
        assert_eq!(participants_1.len(), 1);
        assert_eq!(participants_1[0]["user_id"], user_a);

        let resp = reqwest::Client::new()
            .get(format!("{}/calls/{}", srv.base_url(), room_2))
            .header("Authorization", format!("Bearer {token_b}"))
            .send()
            .await
            .unwrap();
        let body: Value = resp.json().await.unwrap();
        let participants_2 = body["participants"].as_array().unwrap();
        assert_eq!(participants_2.len(), 1);
        assert_eq!(participants_2[0]["user_id"], user_b);
    });
}

// ────────────────────────────────────────────────────────────
//  Test 12: DM call — voice_state_update with DM channel
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-015
// TESTSPEC: WS-017
#[test]
fn test_dm_call() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        // Register two users
        let (token_a, user_a) = register_user(srv, "alice", "alice@test.com").await;
        let (token_b, _user_b) = register_user(srv, "bob", "bob@test.com").await;

        // Create a DM channel between them
        let resp = reqwest::Client::new()
            .post(format!("{}/dm", srv.base_url()))
            .header("Authorization", format!("Bearer {token_a}"))
            .json(&json!({ "recipient_id": _user_b }))
            .send()
            .await
            .unwrap();
        assert!(resp.status().is_success(), "DM channel creation should succeed");
        let body: Value = resp.json().await.unwrap();
        let dm_channel_id = body["id"].as_str().unwrap().to_string();

        // Alice joins DM call via WebSocket voice_state_update
        let mut ws_a = ws_identify(srv, &token_a, "device-a").await;
        let mut ws_b = ws_identify(srv, &token_b, "device-b").await;
        sleep(Duration::from_millis(200)).await;
        let _ = drain_events(&mut ws_a, "").await;
        let _ = drain_events(&mut ws_b, "").await;

        ws_a.send_json(&json!({
            "op": "voice_state_update",
            "d": {
                "channel_id": dm_channel_id,
                "self_mute": false,
                "self_deaf": false
            }
        })).await;

        // Alice should receive CALL_CONFIG
        let config_msg = ws_a
            .receive_json_timeout(Duration::from_secs(3))
            .await
            .expect("alice should receive CALL_CONFIG for DM call");
        assert_eq!(config_msg["t"], "CALL_CONFIG");
        assert!(!config_msg["d"]["room_id"].as_str().unwrap().is_empty());

        // Bob should receive CALL_STARTED for the DM call
        sleep(Duration::from_millis(500)).await;
        let mut got_call_started = false;
        for _ in 0..5 {
            if let Some(msg) = ws_b.receive_json_timeout(Duration::from_secs(2)).await {
                if msg["t"] == "CALL_STARTED" {
                    assert_eq!(msg["d"]["channel_id"], dm_channel_id);
                    assert_eq!(msg["d"]["initiator_id"], user_a);
                    got_call_started = true;
                    break;
                }
            } else {
                break;
            }
        }
        assert!(got_call_started, "bob should receive CALL_STARTED for DM call");

        // Also test DM call via REST POST /calls
        let resp = reqwest::Client::new()
            .post(format!("{}/calls", srv.base_url()))
            .header("Authorization", format!("Bearer {token_b}"))
            .json(&json!({ "channel_id": dm_channel_id }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200, "DM call via REST should succeed");
        let body: Value = resp.json().await.unwrap();
        assert_eq!(body["channel_id"], dm_channel_id);

        ws_a.close().await;
        ws_b.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  Test 13: Disconnect triggers leave_all and room cleanup
// ────────────────────────────────────────────────────────────

// TESTSPEC: WS-015
// TESTSPEC: MEDIA-001
#[test]
fn test_disconnect_triggers_leave() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, user_a) = register_user(srv, "alice", "alice@test.com").await;
        let (token_b, _user_b) = register_user(srv, "bob", "bob@test.com").await;
        let (server_id, invite_code) = create_server_helper(srv, &token_a, "DisconnectServer").await;
        join_server_helper(srv, &token_b, &invite_code).await;
        let channel_id = create_voice_channel(srv, &token_a, &server_id, "Voice").await;

        let mut ws_a = ws_identify(srv, &token_a, "device-a").await;
        let mut ws_b = ws_identify(srv, &token_b, "device-b").await;

        sleep(Duration::from_millis(200)).await;
        let _ = drain_events(&mut ws_a, "").await;
        let _ = drain_events(&mut ws_b, "").await;

        // Alice joins voice channel
        ws_a.send_json(&json!({
            "op": "voice_state_update",
            "d": { "channel_id": channel_id, "self_mute": false, "self_deaf": false }
        })).await;
        let config = ws_a.receive_json_timeout(Duration::from_secs(2)).await.unwrap();
        let room_id = config["d"]["room_id"].as_str().unwrap().to_string();

        sleep(Duration::from_millis(300)).await;
        let _ = drain_events(&mut ws_b, "").await;

        // Alice disconnects abruptly (simulated by closing WS)
        ws_a.close().await;

        // Wait for cleanup
        sleep(Duration::from_millis(1000)).await;

        // Bob should receive VOICE_STATE_UPDATE with null channel_id (leave)
        let mut got_leave = false;
        for _ in 0..5 {
            if let Some(msg) = ws_b.receive_json_timeout(Duration::from_secs(2)).await {
                if msg["t"] == "VOICE_STATE_UPDATE"
                    && msg["d"]["user_id"] == user_a
                    && msg["d"]["channel_id"].is_null()
                {
                    got_leave = true;
                    break;
                }
            } else {
                break;
            }
        }
        assert!(got_leave, "bob should receive leave event after alice disconnects");

        // Room should be destroyed since alice was the only participant
        sleep(Duration::from_millis(500)).await;
        let resp = reqwest::Client::new()
            .get(format!("{}/calls/{}", srv.base_url(), room_id))
            .header("Authorization", format!("Bearer {token_b}"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404, "room should be destroyed after disconnect");

        ws_b.close().await;
    });
}
