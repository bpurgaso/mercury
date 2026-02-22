// Phase 7 — Server-Side E2E Message Routing integration tests.
//  Tests MUST run sequentially (`--test-threads=1` / `nextest -j 1`)
//  because they share a single server and truncate tables between tests.
mod common;

use common::{setup, TestServer};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::time::sleep;

// ────────────────────────────────────────────────────────────
//  Shared infrastructure (same pattern as milestone_1.rs)
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

/// Helper: register a user and return (access_token, user_id).
async fn register_user(srv: &TestServer, username: &str, email: &str) -> (String, String) {
    let mut client = srv.client();
    let (status, _) = client.register_raw(username, email, "password123").await;
    assert_eq!(status, 201, "registration should succeed for {username}");
    (client.access_token.unwrap(), client.user_id.unwrap())
}

/// Helper: create a server and return (server_id, invite_code).
async fn create_server(
    srv: &TestServer,
    token: &str,
    name: &str,
) -> (String, String) {
    let _client = srv.client();
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

/// Helper: create a channel in a server, return channel_id.
async fn create_channel(
    srv: &TestServer,
    token: &str,
    server_id: &str,
    name: &str,
    encryption_mode: &str,
) -> String {
    let resp = reqwest::Client::new()
        .post(format!("{}/servers/{}/channels", srv.base_url(), server_id))
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({
            "name": name,
            "channel_type": "text",
            "encryption_mode": encryption_mode,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201, "channel creation should succeed");
    let body: Value = resp.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

/// Helper: join a server via invite code.
async fn join_server(srv: &TestServer, token: &str, invite_code: &str) {
    let resp = reqwest::Client::new()
        .post(format!("{}/servers/join", srv.base_url()))
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({ "invite_code": invite_code }))
        .send()
        .await
        .unwrap();
    assert!(
        resp.status().is_success(),
        "join server should succeed, got {}",
        resp.status()
    );
}

/// Helper: create a device and return device_id.
async fn create_device(srv: &TestServer, token: &str, name: &str) -> String {
    let resp = reqwest::Client::new()
        .post(format!("{}/devices", srv.base_url()))
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({ "device_name": name }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201, "device creation should succeed");
    let body: Value = resp.json().await.unwrap();
    body["device_id"].as_str().unwrap().to_string()
}

/// Helper: build a MessagePack-encoded message_send for a DM.
fn build_dm_message_send(
    dm_channel_id: &str,
    recipients: Vec<(&str, &[u8], Option<(&[u8], &[u8], i32)>)>,
) -> Vec<u8> {
    let mut recipient_vals = Vec::new();
    for (device_id, ciphertext, x3dh) in recipients {
        let mut pairs = vec![
            (
                rmpv::Value::String("device_id".into()),
                rmpv::Value::String(device_id.into()),
            ),
            (
                rmpv::Value::String("ciphertext".into()),
                rmpv::Value::Binary(ciphertext.to_vec()),
            ),
        ];
        if let Some((ik, ek, prekey_id)) = x3dh {
            let header = rmpv::Value::Map(vec![
                (
                    rmpv::Value::String("sender_identity_key".into()),
                    rmpv::Value::Binary(ik.to_vec()),
                ),
                (
                    rmpv::Value::String("ephemeral_key".into()),
                    rmpv::Value::Binary(ek.to_vec()),
                ),
                (
                    rmpv::Value::String("prekey_id".into()),
                    rmpv::Value::Integer(prekey_id.into()),
                ),
            ]);
            pairs.push((rmpv::Value::String("x3dh_header".into()), header));
        }
        recipient_vals.push(rmpv::Value::Map(pairs));
    }

    let msg = rmpv::Value::Map(vec![
        (
            rmpv::Value::String("op".into()),
            rmpv::Value::String("message_send".into()),
        ),
        (
            rmpv::Value::String("d".into()),
            rmpv::Value::Map(vec![
                (
                    rmpv::Value::String("dm_channel_id".into()),
                    rmpv::Value::String(dm_channel_id.into()),
                ),
                (
                    rmpv::Value::String("recipients".into()),
                    rmpv::Value::Array(recipient_vals),
                ),
            ]),
        ),
    ]);

    let mut buf = Vec::new();
    rmpv::encode::write_value(&mut buf, &msg).unwrap();
    buf
}

/// Helper: build a MessagePack-encoded message_send for a private channel.
fn build_private_message_send(
    channel_id: &str,
    ciphertext: &[u8],
    signature: &[u8],
    sender_device_id: &str,
    iteration: i64,
    epoch: i64,
) -> Vec<u8> {
    let msg = rmpv::Value::Map(vec![
        (
            rmpv::Value::String("op".into()),
            rmpv::Value::String("message_send".into()),
        ),
        (
            rmpv::Value::String("d".into()),
            rmpv::Value::Map(vec![
                (
                    rmpv::Value::String("channel_id".into()),
                    rmpv::Value::String(channel_id.into()),
                ),
                (
                    rmpv::Value::String("encrypted".into()),
                    rmpv::Value::Map(vec![
                        (
                            rmpv::Value::String("ciphertext".into()),
                            rmpv::Value::Binary(ciphertext.to_vec()),
                        ),
                        (
                            rmpv::Value::String("signature".into()),
                            rmpv::Value::Binary(signature.to_vec()),
                        ),
                        (
                            rmpv::Value::String("sender_device_id".into()),
                            rmpv::Value::String(sender_device_id.into()),
                        ),
                        (
                            rmpv::Value::String("iteration".into()),
                            rmpv::Value::Integer(iteration.into()),
                        ),
                        (
                            rmpv::Value::String("epoch".into()),
                            rmpv::Value::Integer(epoch.into()),
                        ),
                    ]),
                ),
            ]),
        ),
    ]);

    let mut buf = Vec::new();
    rmpv::encode::write_value(&mut buf, &msg).unwrap();
    buf
}

/// Helper: build a MessagePack-encoded sender_key_distribute.
fn build_sender_key_distribute(
    channel_id: &str,
    distributions: Vec<(&str, &[u8])>,
) -> Vec<u8> {
    let dist_vals: Vec<rmpv::Value> = distributions
        .iter()
        .map(|(device_id, ciphertext)| {
            rmpv::Value::Map(vec![
                (
                    rmpv::Value::String("device_id".into()),
                    rmpv::Value::String((*device_id).into()),
                ),
                (
                    rmpv::Value::String("ciphertext".into()),
                    rmpv::Value::Binary(ciphertext.to_vec()),
                ),
            ])
        })
        .collect();

    let msg = rmpv::Value::Map(vec![
        (
            rmpv::Value::String("op".into()),
            rmpv::Value::String("sender_key_distribute".into()),
        ),
        (
            rmpv::Value::String("d".into()),
            rmpv::Value::Map(vec![
                (
                    rmpv::Value::String("channel_id".into()),
                    rmpv::Value::String(channel_id.into()),
                ),
                (
                    rmpv::Value::String("distributions".into()),
                    rmpv::Value::Array(dist_vals),
                ),
            ]),
        ),
    ]);

    let mut buf = Vec::new();
    rmpv::encode::write_value(&mut buf, &msg).unwrap();
    buf
}

/// Helper: drain events until we find a specific event type, or timeout.
async fn wait_for_event(
    ws: &mut common::TestWsClient,
    event_type: &str,
    timeout_dur: Duration,
) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + timeout_dur;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match ws.receive_any_timeout(remaining).await {
            Some(msg) if msg["t"] == event_type => return Some(msg),
            Some(_) => continue,
            None => return None,
        }
    }
}

// ────────────────────────────────────────────────────────────
//  Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_standard_channel_message() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _user_a) = register_user(srv, "stdmsg_a", "stdmsg_a@example.com").await;
        let (token_b, _user_b) = register_user(srv, "stdmsg_b", "stdmsg_b@example.com").await;

        let device_a = create_device(srv, &token_a, "device-a").await;
        let device_b = create_device(srv, &token_b, "device-b").await;

        let (server_id, invite_code) = create_server(srv, &token_a, "std-server").await;
        join_server(srv, &token_b, &invite_code).await;
        let channel_id = create_channel(srv, &token_a, &server_id, "general", "standard").await;

        // Connect both users via WS
        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, &device_a).await;
        let _ = ws_a.receive_any_timeout(Duration::from_millis(500)).await;

        let mut ws_b = srv.ws_client(&token_b).await;
        ws_b.identify(&token_b, &device_b).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;

        // Send a standard message via JSON text frame
        ws_a.send_json(&json!({
            "op": "message_send",
            "d": {
                "channel_id": channel_id,
                "content": "hello world"
            }
        }))
        .await;

        // User B should receive MESSAGE_CREATE as binary (MessagePack)
        let msg = wait_for_event(&mut ws_b, "MESSAGE_CREATE", Duration::from_secs(5))
            .await
            .expect("should receive MESSAGE_CREATE");

        assert_eq!(msg["d"]["channel_id"], channel_id);
        assert_eq!(msg["d"]["content"], "hello world");
        assert!(msg["d"]["id"].is_string());
        assert!(msg["seq"].is_number());

        // Fetch history via REST — should return plaintext
        let resp = reqwest::Client::new()
            .get(format!("{}/channels/{}/messages", srv.base_url(), channel_id))
            .header("Authorization", format!("Bearer {}", token_a))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let messages: Vec<Value> = resp.json().await.unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "hello world");

        ws_a.close().await;
        ws_b.close().await;
    });
}

#[test]
fn test_e2e_dm_message() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, user_a) = register_user(srv, "dm_a", "dm_a@example.com").await;
        let (token_b, user_b) = register_user(srv, "dm_b", "dm_b@example.com").await;

        let device_a = create_device(srv, &token_a, "device-a").await;
        let device_b = create_device(srv, &token_b, "device-b").await;

        // Create DM channel
        let resp = reqwest::Client::new()
            .post(format!("{}/dm", srv.base_url()))
            .header("Authorization", format!("Bearer {}", token_a))
            .json(&json!({ "recipient_id": user_b }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let dm_body: Value = resp.json().await.unwrap();
        let dm_channel_id = dm_body["id"].as_str().unwrap().to_string();

        // Connect both users
        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, &device_a).await;
        let _ = ws_a.receive_any_timeout(Duration::from_millis(500)).await;

        let mut ws_b = srv.ws_client(&token_b).await;
        ws_b.identify(&token_b, &device_b).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;

        // Send DM message (MessagePack binary frame)
        let ciphertext_for_b = b"encrypted-for-bob-device";
        let msg_bytes = build_dm_message_send(
            &dm_channel_id,
            vec![(&device_b, ciphertext_for_b, None)],
        );
        ws_a.send_binary(&msg_bytes).await;

        // User B should receive MESSAGE_CREATE with their ciphertext
        let msg = wait_for_event(&mut ws_b, "MESSAGE_CREATE", Duration::from_secs(5))
            .await
            .expect("should receive MESSAGE_CREATE");

        assert_eq!(msg["d"]["dm_channel_id"], dm_channel_id);
        assert_eq!(msg["d"]["sender_id"], user_a);
        // ciphertext should be present as array of bytes
        assert!(msg["d"]["ciphertext"].is_array());

        ws_a.close().await;
        ws_b.close().await;
    });
}

#[test]
fn test_e2e_dm_with_x3dh_header() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _user_a) = register_user(srv, "x3dh_a", "x3dh_a@example.com").await;
        let (token_b, user_b) = register_user(srv, "x3dh_b", "x3dh_b@example.com").await;

        let device_a = create_device(srv, &token_a, "device-a").await;
        let device_b = create_device(srv, &token_b, "device-b").await;

        // Create DM channel
        let resp = reqwest::Client::new()
            .post(format!("{}/dm", srv.base_url()))
            .header("Authorization", format!("Bearer {}", token_a))
            .json(&json!({ "recipient_id": user_b }))
            .send()
            .await
            .unwrap();
        let dm_body: Value = resp.json().await.unwrap();
        let dm_channel_id = dm_body["id"].as_str().unwrap().to_string();

        // Connect both users
        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, &device_a).await;
        let _ = ws_a.receive_any_timeout(Duration::from_millis(500)).await;

        let mut ws_b = srv.ws_client(&token_b).await;
        ws_b.identify(&token_b, &device_b).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;

        // Send DM with x3dh_header
        let identity_key = b"alice-identity-key-32bytes------";
        let ephemeral_key = b"alice-ephemeral-key-32bytes------";
        let ciphertext = b"first-message-ciphertext";
        let msg_bytes = build_dm_message_send(
            &dm_channel_id,
            vec![(&device_b, ciphertext, Some((identity_key, ephemeral_key, 42)))],
        );
        ws_a.send_binary(&msg_bytes).await;

        // User B should receive MESSAGE_CREATE with x3dh_header
        let msg = wait_for_event(&mut ws_b, "MESSAGE_CREATE", Duration::from_secs(5))
            .await
            .expect("should receive MESSAGE_CREATE");

        assert_eq!(msg["d"]["dm_channel_id"], dm_channel_id);
        assert!(msg["d"]["x3dh_header"].is_object(), "x3dh_header should be present");
        assert!(msg["d"]["x3dh_header"]["sender_identity_key"].is_array());
        assert!(msg["d"]["x3dh_header"]["ephemeral_key"].is_array());
        assert_eq!(msg["d"]["x3dh_header"]["prekey_id"], 42);

        // Fetch DM history — should include x3dh_header
        let resp = reqwest::Client::new()
            .get(format!("{}/dm/{}/messages", srv.base_url(), dm_channel_id))
            .header("Authorization", format!("Bearer {}", token_b))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let messages: Vec<Value> = resp.json().await.unwrap();
        assert_eq!(messages.len(), 1);
        assert!(messages[0]["x3dh_header"].is_string(), "x3dh_header should be base64 in REST history");

        ws_a.close().await;
        ws_b.close().await;
    });
}

#[test]
fn test_private_channel_message() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _user_a) = register_user(srv, "priv_a", "priv_a@example.com").await;
        let (token_b, _user_b) = register_user(srv, "priv_b", "priv_b@example.com").await;

        let device_a = create_device(srv, &token_a, "device-a").await;
        let device_b = create_device(srv, &token_b, "device-b").await;

        let (server_id, invite_code) = create_server(srv, &token_a, "priv-server").await;
        join_server(srv, &token_b, &invite_code).await;
        let channel_id = create_channel(srv, &token_a, &server_id, "secret", "private").await;

        // Connect both users
        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, &device_a).await;
        let _ = ws_a.receive_any_timeout(Duration::from_millis(500)).await;

        let mut ws_b = srv.ws_client(&token_b).await;
        ws_b.identify(&token_b, &device_b).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;

        // Send private channel message
        let ciphertext = b"sender-key-encrypted-message";
        let signature = b"ed25519-signature";
        let msg_bytes = build_private_message_send(
            &channel_id,
            ciphertext,
            signature,
            &device_a,
            1,
            0, // epoch 0 matches default sender_key_epoch
        );
        ws_a.send_binary(&msg_bytes).await;

        // User B should receive MESSAGE_CREATE with broadcast ciphertext
        let msg = wait_for_event(&mut ws_b, "MESSAGE_CREATE", Duration::from_secs(5))
            .await
            .expect("should receive MESSAGE_CREATE");

        assert_eq!(msg["d"]["channel_id"], channel_id);
        assert!(msg["d"]["encrypted"].is_object());
        assert!(msg["d"]["encrypted"]["ciphertext"].is_array());
        assert!(msg["d"]["encrypted"]["signature"].is_array());

        // Fetch history — should return encrypted payload
        let resp = reqwest::Client::new()
            .get(format!("{}/channels/{}/messages", srv.base_url(), channel_id))
            .header("Authorization", format!("Bearer {}", token_a))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let messages: Vec<Value> = resp.json().await.unwrap();
        assert_eq!(messages.len(), 1);
        // Private channel messages have ciphertext as base64 string, not content
        assert!(messages[0]["ciphertext"].is_string());

        ws_a.close().await;
        ws_b.close().await;
    });
}

#[test]
fn test_epoch_validation_rejects_stale() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _) = register_user(srv, "epoch_a", "epoch_a@example.com").await;
        let device_a = create_device(srv, &token_a, "device-a").await;

        let (server_id, _) = create_server(srv, &token_a, "epoch-server").await;
        let channel_id = create_channel(srv, &token_a, &server_id, "secret", "private").await;

        // Manually bump the channel's sender_key_epoch
        sqlx::query("UPDATE channels SET sender_key_epoch = 5 WHERE id = $1")
            .bind(uuid::Uuid::parse_str(&channel_id).unwrap())
            .execute(&srv.db)
            .await
            .unwrap();

        let mut ws = srv.ws_client(&token_a).await;
        ws.identify(&token_a, &device_a).await;
        let _ = ws.receive_any_timeout(Duration::from_millis(500)).await;

        // Send with epoch 3 (stale — channel is at epoch 5)
        let msg_bytes = build_private_message_send(
            &channel_id,
            b"ciphertext",
            b"signature",
            &device_a,
            1,
            3, // stale epoch
        );
        ws.send_binary(&msg_bytes).await;

        // Should receive ERROR with STALE_SENDER_KEY
        let error = wait_for_event(&mut ws, "ERROR", Duration::from_secs(5))
            .await
            .expect("should receive ERROR");

        assert_eq!(error["d"]["code"], "STALE_SENDER_KEY");

        ws.close().await;
    });
}

#[test]
fn test_dm_channel_creation_idempotent() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _) = register_user(srv, "idempot_a", "idempot_a@example.com").await;
        let (_, user_b) = register_user(srv, "idempot_b", "idempot_b@example.com").await;

        // Create DM channel
        let resp1 = reqwest::Client::new()
            .post(format!("{}/dm", srv.base_url()))
            .header("Authorization", format!("Bearer {}", token_a))
            .json(&json!({ "recipient_id": user_b }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp1.status(), 200);
        let body1: Value = resp1.json().await.unwrap();
        let id1 = body1["id"].as_str().unwrap().to_string();

        // Create again — should return same channel
        let resp2 = reqwest::Client::new()
            .post(format!("{}/dm", srv.base_url()))
            .header("Authorization", format!("Bearer {}", token_a))
            .json(&json!({ "recipient_id": user_b }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp2.status(), 200);
        let body2: Value = resp2.json().await.unwrap();
        let id2 = body2["id"].as_str().unwrap().to_string();

        assert_eq!(id1, id2, "DM channel creation should be idempotent");
    });
}

#[test]
fn test_dm_history() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _user_a) = register_user(srv, "dmhist_a", "dmhist_a@example.com").await;
        let (token_b, user_b) = register_user(srv, "dmhist_b", "dmhist_b@example.com").await;

        let device_a = create_device(srv, &token_a, "device-a").await;
        let device_b = create_device(srv, &token_b, "device-b").await;

        // Create DM channel
        let resp = reqwest::Client::new()
            .post(format!("{}/dm", srv.base_url()))
            .header("Authorization", format!("Bearer {}", token_a))
            .json(&json!({ "recipient_id": user_b }))
            .send()
            .await
            .unwrap();
        let dm_body: Value = resp.json().await.unwrap();
        let dm_channel_id = dm_body["id"].as_str().unwrap().to_string();

        // Connect user A
        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, &device_a).await;
        let _ = ws_a.receive_any_timeout(Duration::from_millis(500)).await;

        // Send 3 DM messages
        for i in 0..3 {
            let ciphertext = format!("message-{}-for-bob", i);
            let msg_bytes = build_dm_message_send(
                &dm_channel_id,
                vec![(&device_b, ciphertext.as_bytes(), None)],
            );
            ws_a.send_binary(&msg_bytes).await;
            sleep(Duration::from_millis(50)).await;
        }

        sleep(Duration::from_millis(500)).await;

        // Fetch DM history as user B (who has device_b in their session)
        // First, user B needs to connect via WS to set device_id in their session
        let mut ws_b = srv.ws_client(&token_b).await;
        ws_b.identify(&token_b, &device_b).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;
        // drain MESSAGE_CREATE events that arrived
        for _ in 0..3 {
            let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;
        }

        let resp = reqwest::Client::new()
            .get(format!("{}/dm/{}/messages", srv.base_url(), dm_channel_id))
            .header("Authorization", format!("Bearer {}", token_b))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let messages: Vec<Value> = resp.json().await.unwrap();
        assert_eq!(messages.len(), 3, "should have 3 DM messages");

        // Each message should have a base64-encoded ciphertext for device_b
        for msg in &messages {
            assert!(msg["ciphertext"].is_string(), "each message should have base64 ciphertext");
        }

        ws_a.close().await;
        ws_b.close().await;
    });
}

#[test]
fn test_msgpack_framing() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _) = register_user(srv, "msgpack_a", "msgpack_a@example.com").await;
        let (token_b, _) = register_user(srv, "msgpack_b", "msgpack_b@example.com").await;

        let device_a = create_device(srv, &token_a, "device-a").await;
        let device_b = create_device(srv, &token_b, "device-b").await;

        let (server_id, invite_code) = create_server(srv, &token_a, "msgpack-server").await;
        join_server(srv, &token_b, &invite_code).await;
        let channel_id = create_channel(srv, &token_a, &server_id, "general", "standard").await;

        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, &device_a).await;
        let _ = ws_a.receive_any_timeout(Duration::from_millis(500)).await;

        let mut ws_b = srv.ws_client(&token_b).await;
        ws_b.identify(&token_b, &device_b).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;

        // Send standard message (JSON text frame)
        ws_a.send_json(&json!({
            "op": "message_send",
            "d": { "channel_id": channel_id, "content": "test" }
        }))
        .await;

        // MESSAGE_CREATE should come as binary frame (MessagePack)
        let binary_data = ws_b
            .receive_binary_timeout(Duration::from_secs(5))
            .await
            .expect("should receive binary frame for MESSAGE_CREATE");

        // Verify it's valid MessagePack
        let decoded: rmpv::Value =
            rmpv::decode::read_value(&mut &binary_data[..]).expect("should be valid msgpack");
        let map = decoded.as_map().expect("should be a map");
        let t = map
            .iter()
            .find(|(k, _)| k.as_str() == Some("t"))
            .unwrap()
            .1
            .as_str()
            .unwrap();
        assert_eq!(t, "MESSAGE_CREATE");

        // Verify heartbeat still uses JSON text
        ws_a.send_heartbeat(0).await;
        // Drain any intervening text events (e.g. PRESENCE_UPDATE) until we get ACK
        let mut got_ack = false;
        for _ in 0..10 {
            match ws_a.receive_json_timeout(Duration::from_secs(3)).await {
                Some(msg) if msg["t"] == "HEARTBEAT_ACK" => {
                    got_ack = true;
                    break;
                }
                Some(_) => continue, // skip other text events
                None => break,
            }
        }
        assert!(got_ack, "heartbeat ack should be JSON text");

        ws_a.close().await;
        ws_b.close().await;
    });
}

#[test]
fn test_cross_device_isolation() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _user_a) = register_user(srv, "xdev_a", "xdev_a@example.com").await;
        let (token_b, user_b) = register_user(srv, "xdev_b", "xdev_b@example.com").await;

        let device_a = create_device(srv, &token_a, "device-a").await;
        // User B has TWO devices
        let device_b1 = create_device(srv, &token_b, "device-b1").await;
        let device_b2 = create_device(srv, &token_b, "device-b2").await;

        // Create DM channel
        let resp = reqwest::Client::new()
            .post(format!("{}/dm", srv.base_url()))
            .header("Authorization", format!("Bearer {}", token_a))
            .json(&json!({ "recipient_id": user_b }))
            .send()
            .await
            .unwrap();
        let dm_body: Value = resp.json().await.unwrap();
        let dm_channel_id = dm_body["id"].as_str().unwrap().to_string();

        // Connect user A
        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, &device_a).await;
        let _ = ws_a.receive_any_timeout(Duration::from_millis(500)).await;

        // Connect user B device 1
        let (token_b1, _) = {
            let mut c = srv.client();
            c.login_raw("xdev_b@example.com", "password123").await;
            (c.access_token.unwrap(), c.user_id.unwrap())
        };
        let mut ws_b1 = srv.ws_client(&token_b1).await;
        ws_b1.identify(&token_b1, &device_b1).await;
        let _ = ws_b1.receive_any_timeout(Duration::from_millis(500)).await;

        // Connect user B device 2
        let (token_b2, _) = {
            let mut c = srv.client();
            c.login_raw("xdev_b@example.com", "password123").await;
            (c.access_token.unwrap(), c.user_id.unwrap())
        };
        let mut ws_b2 = srv.ws_client(&token_b2).await;
        ws_b2.identify(&token_b2, &device_b2).await;
        let _ = ws_b2.receive_any_timeout(Duration::from_millis(500)).await;

        // drain extra presence events
        sleep(Duration::from_millis(500)).await;
        for _ in 0..5 {
            let _ = ws_b1.receive_any_timeout(Duration::from_millis(100)).await;
            let _ = ws_b2.receive_any_timeout(Duration::from_millis(100)).await;
        }

        // Send DM with per-device ciphertexts
        let cipher_b1 = b"cipher-for-device-b1";
        let cipher_b2 = b"cipher-for-device-b2";
        let msg_bytes = build_dm_message_send(
            &dm_channel_id,
            vec![
                (&device_b1, cipher_b1, None),
                (&device_b2, cipher_b2, None),
            ],
        );
        ws_a.send_binary(&msg_bytes).await;

        // Device B1 should receive only its ciphertext
        let msg_b1 = wait_for_event(&mut ws_b1, "MESSAGE_CREATE", Duration::from_secs(5))
            .await
            .expect("device b1 should receive MESSAGE_CREATE");

        // Device B2 should receive only its ciphertext
        let msg_b2 = wait_for_event(&mut ws_b2, "MESSAGE_CREATE", Duration::from_secs(5))
            .await
            .expect("device b2 should receive MESSAGE_CREATE");

        // Verify the ciphertexts are different (each device got its own)
        let ct_b1 = &msg_b1["d"]["ciphertext"];
        let ct_b2 = &msg_b2["d"]["ciphertext"];
        assert_ne!(ct_b1, ct_b2, "each device should get a different ciphertext");

        ws_a.close().await;
        ws_b1.close().await;
        ws_b2.close().await;
    });
}

#[test]
fn test_message_too_large() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _user_a) = register_user(srv, "large_a", "large_a@example.com").await;
        let (_, user_b) = register_user(srv, "large_b", "large_b@example.com").await;

        let device_a = create_device(srv, &token_a, "device-a").await;
        let device_b_id = create_device(srv, &token_a, "device-b").await; // placeholder

        // Create DM channel
        let resp = reqwest::Client::new()
            .post(format!("{}/dm", srv.base_url()))
            .header("Authorization", format!("Bearer {}", token_a))
            .json(&json!({ "recipient_id": user_b }))
            .send()
            .await
            .unwrap();
        let dm_body: Value = resp.json().await.unwrap();
        let dm_channel_id = dm_body["id"].as_str().unwrap().to_string();

        let mut ws = srv.ws_client(&token_a).await;
        ws.identify(&token_a, &device_a).await;
        let _ = ws.receive_any_timeout(Duration::from_millis(500)).await;

        // Build a >65536 byte binary payload
        let large_ciphertext = vec![0xAA_u8; 70000];
        let msg_bytes = build_dm_message_send(
            &dm_channel_id,
            vec![(&device_b_id, &large_ciphertext, None)],
        );

        ws.send_binary(&msg_bytes).await;

        // Should receive MESSAGE_TOO_LARGE error
        let error = wait_for_event(&mut ws, "ERROR", Duration::from_secs(5))
            .await
            .expect("should receive MESSAGE_TOO_LARGE error");

        assert_eq!(error["d"]["code"], "MESSAGE_TOO_LARGE");

        ws.close().await;
    });
}

#[test]
fn test_sender_key_distribution() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _) = register_user(srv, "skd_a", "skd_a@example.com").await;
        let (token_b, _) = register_user(srv, "skd_b", "skd_b@example.com").await;

        let device_a = create_device(srv, &token_a, "device-a").await;
        let device_b = create_device(srv, &token_b, "device-b").await;

        let (server_id, invite_code) = create_server(srv, &token_a, "skd-server").await;
        join_server(srv, &token_b, &invite_code).await;
        let channel_id = create_channel(srv, &token_a, &server_id, "secret", "private").await;

        // Connect both users
        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, &device_a).await;
        let _ = ws_a.receive_any_timeout(Duration::from_millis(500)).await;

        let mut ws_b = srv.ws_client(&token_b).await;
        ws_b.identify(&token_b, &device_b).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;

        // Send sender_key_distribute
        let sk_ciphertext = b"sender-key-encrypted-via-double-ratchet";
        let dist_bytes = build_sender_key_distribute(
            &channel_id,
            vec![(&device_b, sk_ciphertext)],
        );
        ws_a.send_binary(&dist_bytes).await;

        // User B should receive SENDER_KEY_DISTRIBUTION
        let event = wait_for_event(&mut ws_b, "SENDER_KEY_DISTRIBUTION", Duration::from_secs(5))
            .await
            .expect("should receive SENDER_KEY_DISTRIBUTION");

        assert_eq!(event["d"]["channel_id"], channel_id);
        assert!(event["d"]["sender_id"].is_string());
        assert!(event["d"]["sender_device_id"].is_string());
        assert!(event["d"]["ciphertext"].is_array());

        ws_a.close().await;
        ws_b.close().await;
    });
}

// ────────────────────────────────────────────────────────────
//  Negative / security tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_self_dm_rejected() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, user_a) = register_user(srv, "selfdm_a", "selfdm_a@example.com").await;

        // Attempt to create DM with self
        let resp = reqwest::Client::new()
            .post(format!("{}/dm", srv.base_url()))
            .header("Authorization", format!("Bearer {}", token_a))
            .json(&json!({ "recipient_id": user_a }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 400, "self-DM should be rejected");
    });
}

#[test]
fn test_non_member_dm_rejected() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _user_a) = register_user(srv, "nondm_a", "nondm_a@example.com").await;
        let (token_b, user_b) = register_user(srv, "nondm_b", "nondm_b@example.com").await;
        let (_token_c, _user_c) = register_user(srv, "nondm_c", "nondm_c@example.com").await;

        let _device_a = create_device(srv, &token_a, "device-a").await;
        let device_b = create_device(srv, &token_b, "device-b").await;

        // Create DM between A and B
        let resp = reqwest::Client::new()
            .post(format!("{}/dm", srv.base_url()))
            .header("Authorization", format!("Bearer {}", token_a))
            .json(&json!({ "recipient_id": user_b }))
            .send()
            .await
            .unwrap();
        let dm_body: Value = resp.json().await.unwrap();
        let dm_channel_id = dm_body["id"].as_str().unwrap().to_string();

        // Login as user C (NOT a DM member) and try to send a message
        let (token_c, _) = {
            let mut c = srv.client();
            c.login_raw("nondm_c@example.com", "password123").await;
            (c.access_token.unwrap(), c.user_id.unwrap())
        };
        let device_c = create_device(srv, &token_c, "device-c").await;

        let mut ws_c = srv.ws_client(&token_c).await;
        ws_c.identify(&token_c, &device_c).await;
        let _ = ws_c.receive_any_timeout(Duration::from_millis(500)).await;

        // User C sends a DM message to A-B channel — should be silently dropped
        let msg_bytes = build_dm_message_send(
            &dm_channel_id,
            vec![(&device_b, b"attacker-ciphertext", None)],
        );
        ws_c.send_binary(&msg_bytes).await;

        // Connect user B to verify no message arrives
        let mut ws_b = srv.ws_client(&token_b).await;
        ws_b.identify(&token_b, &device_b).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;

        // No MESSAGE_CREATE should arrive for user B within a reasonable timeout
        let msg = wait_for_event(&mut ws_b, "MESSAGE_CREATE", Duration::from_secs(2)).await;
        assert!(msg.is_none(), "non-member DM message should be rejected");

        ws_c.close().await;
        ws_b.close().await;
    });
}

#[test]
fn test_sender_key_distribute_rejected_on_standard_channel() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _) = register_user(srv, "skdstd_a", "skdstd_a@example.com").await;
        let (token_b, _) = register_user(srv, "skdstd_b", "skdstd_b@example.com").await;

        let device_a = create_device(srv, &token_a, "device-a").await;
        let device_b = create_device(srv, &token_b, "device-b").await;

        let (server_id, invite_code) = create_server(srv, &token_a, "skdstd-server").await;
        join_server(srv, &token_b, &invite_code).await;
        // Create a STANDARD channel (not private)
        let channel_id =
            create_channel(srv, &token_a, &server_id, "general", "standard").await;

        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, &device_a).await;
        let _ = ws_a.receive_any_timeout(Duration::from_millis(500)).await;

        // Attempt sender_key_distribute on a standard channel
        let dist_bytes = build_sender_key_distribute(
            &channel_id,
            vec![(&device_b, b"sender-key-ciphertext")],
        );
        ws_a.send_binary(&dist_bytes).await;

        // Should receive ERROR with INVALID_ENCRYPTION_MODE
        let error = wait_for_event(&mut ws_a, "ERROR", Duration::from_secs(5))
            .await
            .expect("should receive ERROR for sender_key_distribute on standard channel");

        assert_eq!(error["d"]["code"], "INVALID_ENCRYPTION_MODE");

        ws_a.close().await;
    });
}

#[test]
fn test_non_member_private_channel_rejected() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let (token_a, _) = register_user(srv, "nonpriv_a", "nonpriv_a@example.com").await;
        let (token_b, _) = register_user(srv, "nonpriv_b", "nonpriv_b@example.com").await;

        let device_a = create_device(srv, &token_a, "device-a").await;
        let device_b = create_device(srv, &token_b, "device-b").await;

        let (server_id, _invite_code) = create_server(srv, &token_a, "nonpriv-server").await;
        // User B does NOT join the server
        let channel_id =
            create_channel(srv, &token_a, &server_id, "secret", "private").await;

        // Connect user B (not a server member)
        let mut ws_b = srv.ws_client(&token_b).await;
        ws_b.identify(&token_b, &device_b).await;
        let _ = ws_b.receive_any_timeout(Duration::from_millis(500)).await;

        // User B sends a private channel message — should be silently dropped
        let msg_bytes = build_private_message_send(
            &channel_id,
            b"unauthorized-ciphertext",
            b"fake-signature",
            &device_b,
            1,
            0,
        );
        ws_b.send_binary(&msg_bytes).await;

        // Connect user A to verify no message arrives
        let mut ws_a = srv.ws_client(&token_a).await;
        ws_a.identify(&token_a, &device_a).await;
        let _ = ws_a.receive_any_timeout(Duration::from_millis(500)).await;

        let msg = wait_for_event(&mut ws_a, "MESSAGE_CREATE", Duration::from_secs(2)).await;
        assert!(msg.is_none(), "non-member private channel message should be rejected");

        ws_a.close().await;
        ws_b.close().await;
    });
}
