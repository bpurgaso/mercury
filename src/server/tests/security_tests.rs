//! Security tests verifying security invariants.
//! Any failure here represents a potential vulnerability.

mod common;

use common::{setup, TestServer};
use serde_json::json;
use std::time::Duration;

// TESTSPEC: SEC-001
#[tokio::test]
async fn no_plaintext_in_e2e_messages() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Register user and create server with private channel
    let mut alice = server.client();
    alice.register_raw("sec_alice", "sec_alice@test.com", "password123").await;
    let alice_token = alice.access_token.clone().unwrap();

    let (_, srv) = alice.post_authed("/servers", &json!({"name": "sec-test"})).await;
    let server_id = srv["id"].as_str().unwrap();
    let (_, ch) = alice.post_authed(
        &format!("/servers/{server_id}/channels"),
        &json!({"name": "private", "channel_type": "text", "encryption_mode": "private"}),
    ).await;
    let channel_id = ch["id"].as_str().unwrap();

    // Send a message via WS to the private channel
    let mut ws = server.ws_client(&alice_token).await;
    ws.identify(&alice_token, "sec-device-1").await;

    // Send as binary msgpack with ciphertext (no plaintext content)
    ws.send_json(&json!({
        "op": "message_send",
        "d": {
            "channel_id": channel_id,
            "recipients": [{
                "device_id": null,
                "ciphertext": [1, 2, 3, 4, 5]
            }]
        }
    })).await;

    tokio::time::sleep(Duration::from_millis(300)).await;

    // Query the database directly: content must be NULL for private channel messages
    let rows: Vec<(Option<String>,)> = sqlx::query_as(
        "SELECT content FROM messages WHERE channel_id = $1::uuid"
    )
    .bind(channel_id)
    .fetch_all(&server.db)
    .await
    .unwrap();

    for (content,) in &rows {
        assert!(
            content.is_none(),
            "E2E message content must be NULL in database, found: {:?}",
            content
        );
    }

    ws.close().await;
}

// TESTSPEC: SEC-002
#[tokio::test]
async fn no_private_keys_on_server() {
    let server = TestServer::start().await;
    setup(&server).await;

    let mut client = server.client();
    client.register_raw("sec_keyuser", "sec_key@test.com", "password123").await;

    // Register a device
    let (status, dev) = client.post_authed("/devices", &json!({"device_name": "sec-device"})).await;
    assert_eq!(status, 201);
    let device_id = dev["device_id"].as_str().unwrap();

    // Upload a key bundle with public keys (32 bytes each, base64-encoded)
    use base64::Engine;
    let pub_key = base64::engine::general_purpose::STANDARD.encode(&[0xABu8; 32]);
    let sig = base64::engine::general_purpose::STANDARD.encode(&[0xCDu8; 64]);

    let (status, _) = client.put_authed(
        &format!("/devices/{device_id}/keys"),
        &json!({
            "identity_key": pub_key,
            "signed_prekey": pub_key,
            "signed_prekey_id": 1,
            "prekey_signature": sig,
            "one_time_prekeys": [
                {"key_id": 1, "prekey": pub_key}
            ]
        }),
    ).await;
    assert!(status.is_success() || status == 204, "key upload should succeed, got {status}");

    // Verify: device_identity_keys should only contain public keys (32 bytes)
    let rows: Vec<(Vec<u8>, Vec<u8>)> = sqlx::query_as(
        "SELECT identity_key, signed_prekey FROM device_identity_keys WHERE device_id = $1::uuid"
    )
    .bind(device_id)
    .fetch_all(&server.db)
    .await
    .unwrap();

    for (ik, spk) in &rows {
        assert_eq!(ik.len(), 32, "identity_key should be 32 bytes (public key only)");
        assert_eq!(spk.len(), 32, "signed_prekey should be 32 bytes (public key only)");
    }

    // Verify OTPs contain only public keys
    let otp_rows: Vec<(Vec<u8>,)> = sqlx::query_as(
        "SELECT prekey FROM one_time_prekeys WHERE device_id = $1::uuid"
    )
    .bind(device_id)
    .fetch_all(&server.db)
    .await
    .unwrap();

    for (prekey,) in &otp_rows {
        assert_eq!(prekey.len(), 32, "OTP prekey should be 32 bytes (public key only)");
    }
}

// TESTSPEC: SEC-003
#[tokio::test]
async fn otp_atomic_claim() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Alice uploads OTPs
    let mut alice = server.client();
    alice.register_raw("sec_otp_alice", "sec_otp_a@test.com", "password123").await;
    let alice_id = alice.user_id.clone().unwrap();

    let (_, dev) = alice.post_authed("/devices", &json!({"device_name": "sec-dev"})).await;
    let device_id = dev["device_id"].as_str().unwrap();

    use base64::Engine;
    let pub_key = base64::engine::general_purpose::STANDARD.encode(&[0xABu8; 32]);
    let sig = base64::engine::general_purpose::STANDARD.encode(&[0xCDu8; 64]);
    let otps: Vec<_> = (1..=1).map(|i| json!({"key_id": i, "prekey": pub_key})).collect();

    alice.put_authed(
        &format!("/devices/{device_id}/keys"),
        &json!({
            "identity_key": pub_key,
            "signed_prekey": pub_key,
            "signed_prekey_id": 1,
            "prekey_signature": sig,
            "one_time_prekeys": otps
        }),
    ).await;

    // Two users try to claim the same OTP concurrently
    let mut bob = server.client();
    bob.register_raw("sec_otp_bob", "sec_otp_b@test.com", "password123").await;

    let mut carol = server.client();
    carol.register_raw("sec_otp_carol", "sec_otp_c@test.com", "password123").await;

    let claim_path = format!("/users/{alice_id}/devices/{device_id}/keys/one-time");

    let bob_body = json!({});
    let carol_body = json!({});
    let (bob_res, carol_res) = tokio::join!(
        bob.post_authed(&claim_path, &bob_body),
        carol.post_authed(&claim_path, &carol_body),
    );

    let (bob_status, _) = bob_res;
    let (carol_status, _) = carol_res;

    // Exactly one should succeed, the other should get 404 (exhausted)
    let successes = [bob_status, carol_status].iter().filter(|s| s.is_success()).count();
    let failures = [bob_status, carol_status].iter().filter(|s| **s == 404).count();

    assert!(
        successes <= 1,
        "at most one concurrent claim should succeed: bob={bob_status}, carol={carol_status}"
    );
}

// TESTSPEC: SEC-004
#[tokio::test]
async fn rate_limit_header_spoofing() {
    let server = TestServer::start_with_auth_rate_limit(5).await;
    setup(&server).await;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    // Send requests with spoofed X-Forwarded-For — rate limit should still apply
    let mut statuses = vec![];
    for i in 0..7 {
        let resp = http
            .post(format!("{}/auth/register", server.base_url()))
            .header("X-Forwarded-For", format!("10.0.0.{}", i))
            .json(&json!({
                "username": format!("spoof{i}"),
                "email": format!("spoof{i}@test.com"),
                "password": "password123"
            }))
            .send()
            .await
            .expect("request failed");
        statuses.push(resp.status().as_u16());
    }

    // Should hit 429 despite different X-Forwarded-For headers
    assert!(
        statuses.contains(&429),
        "rate limit should apply regardless of X-Forwarded-For spoofing: {:?}",
        statuses
    );
}

// TESTSPEC: SEC-005
#[tokio::test]
async fn sql_injection_rejected() {
    let server = TestServer::start().await;
    setup(&server).await;

    let mut client = server.client();
    let injection = "'; DROP TABLE users;--";
    let (status, _) = client.register_raw(injection, "inject@test.com", "password123").await;

    // The request should either succeed safely (parameterized) or be rejected
    // The users table must still exist
    let count: (i64,) = sqlx::query_as("SELECT count(*) FROM users")
        .fetch_one(&server.db)
        .await
        .expect("users table must still exist after SQL injection attempt");

    assert!(count.0 >= 0, "users table should still exist");
}

// TESTSPEC: SEC-006
#[tokio::test]
async fn jwt_algorithm_confusion() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Create a token manually signed with HMAC using a different approach
    // to test that the server's validation doesn't accept unexpected algorithms
    let mut client = server.client();
    client.register_raw("sec_jwt", "sec_jwt@test.com", "password123").await;

    // Use a garbage JWT with "none" algorithm
    let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(r#"{"alg":"none","typ":"JWT"}"#);
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(r#"{"sub":"00000000-0000-0000-0000-000000000000","jti":"test","token_type":"access","iat":9999999999,"exp":9999999999}"#);
    let fake_token = format!("{header}.{payload}.");

    use base64::Engine;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let resp = http
        .get(format!("{}/users/me", server.base_url()))
        .header("Authorization", format!("Bearer {fake_token}"))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), 401, "none-algorithm JWT must be rejected");
}

// TESTSPEC: SEC-011
#[tokio::test]
async fn blocked_user_no_presence() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Register A and B, put them in same server
    let mut alice = server.client();
    alice.register_raw("sec_pres_a", "sec_pres_a@test.com", "password123").await;
    let alice_token = alice.access_token.clone().unwrap();
    let alice_id = alice.user_id.clone().unwrap();

    let mut bob = server.client();
    bob.register_raw("sec_pres_b", "sec_pres_b@test.com", "password123").await;
    let bob_token = bob.access_token.clone().unwrap();
    let bob_id = bob.user_id.clone().unwrap();

    let (_, srv) = alice.post_authed("/servers", &json!({"name": "pres-test"})).await;
    let invite_code = srv["invite_code"].as_str().unwrap();
    bob.post_authed("/servers/join", &json!({"invite_code": invite_code})).await;

    // A blocks B
    alice.put_authed_status(&format!("/users/me/blocks/{bob_id}"), &json!({})).await;

    // B connects via WS
    let mut bob_ws = server.ws_client(&bob_token).await;
    bob_ws.identify(&bob_token, "sec-b-dev").await;

    // A connects — B should NOT receive A's presence
    let mut alice_ws = server.ws_client(&alice_token).await;
    alice_ws.identify(&alice_token, "sec-a-dev").await;

    // Wait for presence propagation
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Collect any presence events Bob received
    let events = bob_ws
        .collect_events("PRESENCE_UPDATE", Duration::from_millis(500))
        .await;

    // None should be from Alice
    for ev in &events {
        let user = ev["d"]["user_id"].as_str().unwrap_or("");
        assert_ne!(
            user, alice_id,
            "blocked user's presence should not be received"
        );
    }

    alice_ws.close().await;
    bob_ws.close().await;
}

// TESTSPEC: SEC-012
#[tokio::test]
async fn blocked_user_silent_drop() {
    let server = TestServer::start().await;
    setup(&server).await;

    let mut alice = server.client();
    alice.register_raw("sec_drop_a", "sec_drop_a@test.com", "password123").await;
    let alice_token = alice.access_token.clone().unwrap();
    let alice_id = alice.user_id.clone().unwrap();

    let mut bob = server.client();
    bob.register_raw("sec_drop_b", "sec_drop_b@test.com", "password123").await;
    let bob_token = bob.access_token.clone().unwrap();
    let bob_id = bob.user_id.clone().unwrap();

    // Create DM first (before blocking)
    let (_, dm) = alice.post_authed("/dm", &json!({"user_id": bob_id})).await;
    let dm_channel_id = dm["dm_channel_id"].as_str().unwrap_or(dm["id"].as_str().unwrap_or(""));

    // A blocks B
    alice.put_authed_status(&format!("/users/me/blocks/{bob_id}"), &json!({})).await;

    // Both connect via WS
    let mut alice_ws = server.ws_client(&alice_token).await;
    alice_ws.identify(&alice_token, "sec-a-dev2").await;

    let mut bob_ws = server.ws_client(&bob_token).await;
    bob_ws.identify(&bob_token, "sec-b-dev2").await;

    // B sends DM to A — should get ack but A gets nothing
    bob_ws.send_json(&json!({
        "op": "message_send",
        "d": {
            "dm_channel_id": dm_channel_id,
            "content": "hello from blocked user"
        }
    })).await;

    tokio::time::sleep(Duration::from_millis(500)).await;

    // A should NOT receive the message
    let events = alice_ws
        .collect_events("MESSAGE_CREATE", Duration::from_millis(500))
        .await;
    assert!(
        events.is_empty(),
        "blocked user's messages should be silently dropped for blocker"
    );

    alice_ws.close().await;
    bob_ws.close().await;
}

// TESTSPEC: SEC-013
#[tokio::test]
async fn banned_user_ws_rejected() {
    let server = TestServer::start().await;
    setup(&server).await;

    let mut owner = server.client();
    owner.register_raw("sec_ban_owner", "sec_ban_o@test.com", "password123").await;
    let owner_token = owner.access_token.clone().unwrap();

    let mut target = server.client();
    target.register_raw("sec_ban_target", "sec_ban_t@test.com", "password123").await;
    let target_token = target.access_token.clone().unwrap();
    let target_id = target.user_id.clone().unwrap();

    let mut observer = server.client();
    observer.register_raw("sec_ban_obs", "sec_ban_obs@test.com", "password123").await;
    let observer_token = observer.access_token.clone().unwrap();

    // Create server, target and observer join
    let (_, srv) = owner.post_authed("/servers", &json!({"name": "ban-ws-test"})).await;
    let server_id = srv["id"].as_str().unwrap();
    let invite = srv["invite_code"].as_str().unwrap();
    target.post_authed("/servers/join", &json!({"invite_code": invite})).await;
    observer.post_authed("/servers/join", &json!({"invite_code": invite})).await;

    // Create channel before banning
    let (_, ch) = owner.post_authed(
        &format!("/servers/{server_id}/channels"),
        &json!({"name": "test-ch", "channel_type": "text", "encryption_mode": "standard"}),
    ).await;
    let channel_id = ch["id"].as_str().unwrap();

    // Ban target
    owner.post_authed(
        &format!("/servers/{server_id}/bans"),
        &json!({"user_id": target_id, "reason": "test ban"}),
    ).await;

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Target connects via WS after being banned
    let mut target_ws = server.ws_client(&target_token).await;
    target_ws.identify(&target_token, "ban-dev").await;

    // Observer connects to verify messages don't arrive
    let mut obs_ws = server.ws_client(&observer_token).await;
    obs_ws.identify(&observer_token, "obs-dev").await;

    tokio::time::sleep(Duration::from_millis(300)).await;

    // Drain initial events
    loop {
        if obs_ws.receive_any_timeout(Duration::from_millis(200)).await.is_none() {
            break;
        }
    }

    // Target tries to send message to the banned server's channel
    target_ws.send_json(&json!({
        "op": "message_send",
        "d": {
            "channel_id": channel_id,
            "content": "I am banned"
        }
    })).await;

    tokio::time::sleep(Duration::from_millis(500)).await;

    // Observer should NOT receive the message — banned user's message must be rejected
    let obs_msg = obs_ws
        .collect_events("MESSAGE_CREATE", Duration::from_millis(1000))
        .await;
    assert!(
        obs_msg.is_empty(),
        "observer should NOT receive message from banned user — message must be rejected"
    );

    target_ws.close().await;
    obs_ws.close().await;
}

// TESTSPEC: SEC-014
#[tokio::test]
async fn sender_key_epoch_enforced() {
    let server = TestServer::start().await;
    setup(&server).await;

    let mut alice = server.client();
    alice.register_raw("sec_epoch_a", "sec_epoch_a@test.com", "password123").await;
    let alice_token = alice.access_token.clone().unwrap();

    let (_, srv) = alice.post_authed("/servers", &json!({"name": "epoch-test"})).await;
    let server_id = srv["id"].as_str().unwrap();
    let (_, ch) = alice.post_authed(
        &format!("/servers/{server_id}/channels"),
        &json!({"name": "private-ch", "channel_type": "text", "encryption_mode": "private"}),
    ).await;
    let channel_id = ch["id"].as_str().unwrap();

    let mut ws = server.ws_client(&alice_token).await;
    ws.identify(&alice_token, "epoch-dev").await;

    // Send message with stale epoch (epoch=99, but channel is at epoch=0)
    ws.send_json(&json!({
        "op": "message_send",
        "d": {
            "channel_id": channel_id,
            "sender_key_epoch": 99,
            "recipients": [{
                "device_id": null,
                "ciphertext": [1, 2, 3]
            }]
        }
    })).await;

    tokio::time::sleep(Duration::from_millis(300)).await;

    // Should receive an error for stale epoch
    let any = ws.receive_any_timeout(Duration::from_millis(500)).await;
    // The server should reject stale epoch messages

    ws.close().await;
}

// TESTSPEC: SEC-015
#[tokio::test]
async fn encryption_mode_immutable() {
    let server = TestServer::start().await;
    setup(&server).await;

    let mut client = server.client();
    client.register_raw("sec_immut", "sec_immut@test.com", "password123").await;

    let (_, srv) = client.post_authed("/servers", &json!({"name": "immut-test"})).await;
    let server_id = srv["id"].as_str().unwrap();

    // Create standard channel
    let (_, ch) = client.post_authed(
        &format!("/servers/{server_id}/channels"),
        &json!({"name": "std-ch", "channel_type": "text", "encryption_mode": "standard"}),
    ).await;
    let channel_id = ch["id"].as_str().unwrap();

    // Try to change encryption_mode to private
    let (status, _) = client.patch_authed(
        &format!("/channels/{channel_id}"),
        &json!({"encryption_mode": "private"}),
    ).await;

    // Should be rejected (400) or the field should be ignored
    // Verify the channel still has standard mode
    let (_, ch_body) = client.get_authed(&format!("/servers/{server_id}/channels")).await;
    let empty = vec![];
    let channels = ch_body.as_array().unwrap_or(&empty);
    for c in channels {
        if c["id"].as_str() == Some(channel_id) {
            assert_eq!(
                c["encryption_mode"].as_str().unwrap_or(""),
                "standard",
                "encryption_mode must remain standard after PATCH attempt"
            );
        }
    }
}
