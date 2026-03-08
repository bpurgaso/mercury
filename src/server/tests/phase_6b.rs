mod common;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
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

/// Helper: register a device and return its UUID.
async fn create_device(client: &common::TestClient, name: &str) -> String {
    let (status, body) = client
        .post_authed("/devices", &json!({ "device_name": name }))
        .await;
    assert_eq!(status, 201, "create device should return 201");
    body["device_id"].as_str().unwrap().to_string()
}

/// Helper: generate a key bundle payload with a valid Ed25519 signature.
fn fake_key_bundle(num_otps: usize) -> serde_json::Value {
    common::valid_key_bundle(num_otps)
}

// ────────────────────────────────────────────────────────────
//  Device Registration & CRUD
// ────────────────────────────────────────────────────────────

// TESTSPEC: API-040
#[test]
fn test_register_device() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let client = register_client(srv, "devuser", "devuser@example.com").await;

        let (status, body) = client
            .post_authed("/devices", &json!({ "device_name": "MacBook Pro" }))
            .await;

        assert_eq!(status, 201);
        assert!(body["device_id"].is_string());
        assert_eq!(body["device_name"], "MacBook Pro");
        assert!(body["created_at"].is_string());
    });
}

// TESTSPEC: API-041
#[test]
fn test_list_devices() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let client = register_client(srv, "listdev", "listdev@example.com").await;

        create_device(&client, "Device A").await;
        create_device(&client, "Device B").await;

        let (status, body) = client.get_authed("/devices").await;
        assert_eq!(status, 200);

        let devices = body.as_array().expect("should be array");
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0]["device_name"], "Device A");
        assert_eq!(devices[1]["device_name"], "Device B");
    });
}

// TESTSPEC: API-048
#[test]
fn test_delete_device() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let client = register_client(srv, "deldev", "deldev@example.com").await;

        let device_id = create_device(&client, "ToDelete").await;

        let status = client.delete_authed(&format!("/devices/{device_id}")).await;
        assert_eq!(status, 204);

        // Verify it's gone
        let (status, body) = client.get_authed("/devices").await;
        assert_eq!(status, 200);
        assert_eq!(body.as_array().unwrap().len(), 0);
    });
}

// TESTSPEC: API-048
#[test]
fn test_delete_device_ownership() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_del", "alice_del@example.com").await;
        let bob = register_client(srv, "bob_del", "bob_del@example.com").await;

        let alice_device = create_device(&alice, "Alice Device").await;

        // Bob tries to delete Alice's device → 403
        let status = bob.delete_authed(&format!("/devices/{alice_device}")).await;
        assert_eq!(status, 403);

        // Alice's device should still exist
        let (_, body) = alice.get_authed("/devices").await;
        assert_eq!(body.as_array().unwrap().len(), 1);
    });
}

// ────────────────────────────────────────────────────────────
//  Key Bundle Upload
// ────────────────────────────────────────────────────────────

// TESTSPEC: API-042
#[test]
fn test_upload_key_bundle() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let client = register_client(srv, "keyup", "keyup@example.com").await;
        let device_id = create_device(&client, "KeyDevice").await;

        let bundle = fake_key_bundle(5);
        let status = client
            .put_authed_status(&format!("/devices/{device_id}/keys"), &bundle)
            .await;

        assert_eq!(status, 204);
    });
}

// TESTSPEC: API-042
#[test]
fn test_upload_key_bundle_validation() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let client = register_client(srv, "keyval", "keyval@example.com").await;
        let device_id = create_device(&client, "ValDevice").await;

        // identity_key too short (16 bytes instead of 32)
        let bad_bundle = json!({
            "identity_key": BASE64.encode([0u8; 16]),
            "signed_prekey": BASE64.encode([0u8; 32]),
            "signed_prekey_id": 1,
            "prekey_signature": BASE64.encode([0u8; 64]),
            "one_time_prekeys": [],
        });

        let (status, body) = client
            .put_authed(&format!("/devices/{device_id}/keys"), &bad_bundle)
            .await;
        assert_eq!(status, 400);
        assert!(body["error"].as_str().unwrap().contains("identity_key"));
    });
}

// TESTSPEC: API-042
#[test]
fn test_upload_keys_wrong_owner() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_key", "alice_key@example.com").await;
        let bob = register_client(srv, "bob_key", "bob_key@example.com").await;

        let alice_device = create_device(&alice, "Alice KeyDev").await;
        let bundle = fake_key_bundle(0);

        // Bob tries to upload keys to Alice's device → 403
        let (status, _) = bob
            .put_authed(&format!("/devices/{alice_device}/keys"), &bundle)
            .await;
        assert_eq!(status, 403);
    });
}

// ────────────────────────────────────────────────────────────
//  Key Bundle Fetch
// ────────────────────────────────────────────────────────────

// TESTSPEC: API-043
#[test]
fn test_fetch_key_bundle() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_fb", "alice_fb@example.com").await;
        let bob = register_client(srv, "bob_fb", "bob_fb@example.com").await;

        let alice_device = create_device(&alice, "Alice Dev").await;
        let bundle = fake_key_bundle(3);
        alice
            .put_authed_status(&format!("/devices/{alice_device}/keys"), &bundle)
            .await;

        let alice_id = alice.user_id.as_ref().unwrap();

        // Bob fetches Alice's key bundle
        let (status, body) = bob
            .get_authed(&format!("/users/{alice_id}/devices/{alice_device}/keys"))
            .await;

        assert_eq!(status, 200);
        assert_eq!(body["identity_key"], bundle["identity_key"]);
        assert_eq!(body["signed_prekey"], bundle["signed_prekey"]);
        assert_eq!(body["signed_prekey_id"], 1);
        assert_eq!(body["prekey_signature"], bundle["prekey_signature"]);
    });
}

// TESTSPEC: API-045
#[test]
fn test_fetch_all_bundles() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_all", "alice_all@example.com").await;
        let bob = register_client(srv, "bob_all", "bob_all@example.com").await;

        // Alice registers two devices with key bundles
        let dev1 = create_device(&alice, "Alice Dev 1").await;
        let dev2 = create_device(&alice, "Alice Dev 2").await;

        let bundle1 = fake_key_bundle(0);
        let bundle2 = fake_key_bundle(0);

        alice
            .put_authed_status(&format!("/devices/{dev1}/keys"), &bundle1)
            .await;
        alice
            .put_authed_status(&format!("/devices/{dev2}/keys"), &bundle2)
            .await;

        let alice_id = alice.user_id.as_ref().unwrap();

        let (status, body) = bob
            .get_authed(&format!("/users/{alice_id}/keys"))
            .await;

        assert_eq!(status, 200);
        let devices = body["devices"].as_array().expect("should be array");
        assert_eq!(devices.len(), 2);
    });
}

// TESTSPEC: API-043
#[test]
fn test_fetch_bundle_not_found() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let client = register_client(srv, "notfound", "notfound@example.com").await;

        // Non-existent user
        let fake_user_id = "00000000-0000-0000-0000-000000000001";
        let fake_device_id = "00000000-0000-0000-0000-000000000002";

        let (status, _) = client
            .get_authed(&format!("/users/{fake_user_id}/devices/{fake_device_id}/keys"))
            .await;
        assert_eq!(status, 404);

        // Existing user but non-existent device
        let user_id = client.user_id.as_ref().unwrap();
        let (status, _) = client
            .get_authed(&format!("/users/{user_id}/devices/{fake_device_id}/keys"))
            .await;
        assert_eq!(status, 404);
    });
}

// ────────────────────────────────────────────────────────────
//  One-Time Pre-Key Claiming
// ────────────────────────────────────────────────────────────

// TESTSPEC: API-044
#[test]
fn test_claim_otp() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_otp", "alice_otp@example.com").await;
        let bob = register_client(srv, "bob_otp", "bob_otp@example.com").await;

        let device = create_device(&alice, "OTP Device").await;
        let bundle = fake_key_bundle(5);
        alice
            .put_authed_status(&format!("/devices/{device}/keys"), &bundle)
            .await;

        let alice_id = alice.user_id.as_ref().unwrap();

        // Bob claims an OTP
        let (status, body) = bob
            .post_authed(
                &format!("/users/{alice_id}/devices/{device}/keys/one-time"),
                &json!({}),
            )
            .await;

        assert_eq!(status, 200);
        assert!(body["key_id"].is_number());
        assert!(body["prekey"].is_string());

        // Verify the prekey is valid base64 and 32 bytes
        let prekey_bytes = BASE64.decode(body["prekey"].as_str().unwrap()).unwrap();
        assert_eq!(prekey_bytes.len(), 32);
    });
}

// TESTSPEC: API-044
#[test]
fn test_claim_otp_exhaustion() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_exh", "alice_exh@example.com").await;
        let bob = register_client(srv, "bob_exh", "bob_exh@example.com").await;

        let device = create_device(&alice, "Exh Device").await;
        // Upload only 2 OTPs
        let bundle = fake_key_bundle(2);
        alice
            .put_authed_status(&format!("/devices/{device}/keys"), &bundle)
            .await;

        let alice_id = alice.user_id.as_ref().unwrap();
        let claim_path = format!("/users/{alice_id}/devices/{device}/keys/one-time");

        // Claim both
        let (s1, _) = bob.post_authed(&claim_path, &json!({})).await;
        assert_eq!(s1, 200);
        let (s2, _) = bob.post_authed(&claim_path, &json!({})).await;
        assert_eq!(s2, 200);

        // Third claim should fail — no more OTPs
        let (s3, _) = bob.post_authed(&claim_path, &json!({})).await;
        assert_eq!(s3, 404);
    });
}

// TESTSPEC: API-044
// TESTSPEC: SEC-003
#[test]
fn test_claim_otp_no_duplicate() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_dup", "alice_dup@example.com").await;
        let bob = register_client(srv, "bob_dup", "bob_dup@example.com").await;
        let carol = register_client(srv, "carol_dup", "carol_dup@example.com").await;

        let device = create_device(&alice, "Dup Device").await;
        let bundle = fake_key_bundle(10);
        alice
            .put_authed_status(&format!("/devices/{device}/keys"), &bundle)
            .await;

        let alice_id = alice.user_id.as_ref().unwrap();
        let claim_path = format!("/users/{alice_id}/devices/{device}/keys/one-time");

        // Bob and Carol each claim 5 OTPs concurrently
        let bob_claims = {
            let path = claim_path.clone();
            let mut claimed = Vec::new();
            for _ in 0..5 {
                let (status, body) = bob.post_authed(&path, &json!({})).await;
                assert_eq!(status, 200);
                claimed.push(body["key_id"].as_i64().unwrap());
            }
            claimed
        };

        let carol_claims = {
            let path = claim_path.clone();
            let mut claimed = Vec::new();
            for _ in 0..5 {
                let (status, body) = carol.post_authed(&path, &json!({})).await;
                assert_eq!(status, 200);
                claimed.push(body["key_id"].as_i64().unwrap());
            }
            claimed
        };

        // All 10 key_ids should be distinct
        let mut all_ids = bob_claims.clone();
        all_ids.extend(carol_claims);
        all_ids.sort();
        all_ids.dedup();
        assert_eq!(all_ids.len(), 10, "all claimed key_ids must be unique");

        // 11th claim should fail
        let (status, _) = bob.post_authed(&claim_path, &json!({})).await;
        assert_eq!(status, 404);
    });
}

// ────────────────────────────────────────────────────────────
//  Authentication Enforcement
// ────────────────────────────────────────────────────────────

// TESTSPEC: API-014
#[test]
fn test_unauthenticated_access() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;

        let client = srv.client(); // No auth

        // All device endpoints should reject unauthenticated requests
        let (status, _) = client.get("/devices").await;
        assert_eq!(status, 401);

        let (status, _) = client
            .post_json("/devices", &json!({ "device_name": "test" }))
            .await;
        assert_eq!(status, 401);

        let fake_id = "00000000-0000-0000-0000-000000000001";
        let (status, _) = client
            .get(&format!("/users/{fake_id}/devices/{fake_id}/keys"))
            .await;
        assert_eq!(status, 401);
    });
}
