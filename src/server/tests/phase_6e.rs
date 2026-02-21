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

// ────────────────────────────────────────────────────────────
//  Device List Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_upload_and_fetch_device_list() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_dl", "alice_dl@example.com").await;
        let bob = register_client(srv, "bob_dl", "bob_dl@example.com").await;

        let signed_list = BASE64.encode(b"signed-device-list-payload");
        let master_verify_key = BASE64.encode([0xAAu8; 32]);
        let signature = BASE64.encode([0xBBu8; 64]);

        // Alice uploads her device list
        let status = alice
            .put_authed_status(
                "/users/me/device-list",
                &json!({
                    "signed_list": signed_list,
                    "master_verify_key": master_verify_key,
                    "signature": signature,
                }),
            )
            .await;
        assert_eq!(status, 204);

        // Bob fetches Alice's device list
        let alice_id = alice.user_id.as_ref().unwrap();
        let (status, body) = bob
            .get_authed(&format!("/users/{alice_id}/device-list"))
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["signed_list"], signed_list);
        assert_eq!(body["master_verify_key"], master_verify_key);
        assert_eq!(body["signature"], signature);
    });
}

#[test]
fn test_device_list_tofu_violation() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_tofu", "alice_tofu@example.com").await;

        let signed_list = BASE64.encode(b"device-list-v1");
        let mvk1 = BASE64.encode([0xAAu8; 32]);
        let mvk2 = BASE64.encode([0xBBu8; 32]); // Different key
        let signature = BASE64.encode([0xCCu8; 64]);

        // First upload succeeds (TOFU — establishes the key)
        let status = alice
            .put_authed_status(
                "/users/me/device-list",
                &json!({
                    "signed_list": signed_list,
                    "master_verify_key": mvk1,
                    "signature": signature,
                }),
            )
            .await;
        assert_eq!(status, 204);

        // Second upload with DIFFERENT master_verify_key → rejected
        let (status, body) = alice
            .put_authed(
                "/users/me/device-list",
                &json!({
                    "signed_list": signed_list,
                    "master_verify_key": mvk2,
                    "signature": signature,
                }),
            )
            .await;
        assert_eq!(status, 403);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("trust-on-first-use"),
        );

        // Same key still works (update is allowed)
        let new_signed_list = BASE64.encode(b"device-list-v2");
        let new_signature = BASE64.encode([0xDDu8; 64]);
        let status = alice
            .put_authed_status(
                "/users/me/device-list",
                &json!({
                    "signed_list": new_signed_list,
                    "master_verify_key": mvk1,
                    "signature": new_signature,
                }),
            )
            .await;
        assert_eq!(status, 204);
    });
}

// ────────────────────────────────────────────────────────────
//  Key Backup Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_upload_and_fetch_key_backup() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_kb", "alice_kb@example.com").await;

        let encrypted_backup = BASE64.encode(b"encrypted-backup-blob");
        let salt = BASE64.encode([0x11u8; 16]);

        // Upload key backup
        let status = alice
            .put_authed_status(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": encrypted_backup,
                    "key_derivation_salt": salt,
                }),
            )
            .await;
        assert_eq!(status, 204);

        // Fetch key backup
        let (status, body) = alice.get_authed("/users/me/key-backup").await;
        assert_eq!(status, 200);
        assert_eq!(body["encrypted_backup"], encrypted_backup);
        assert_eq!(body["key_derivation_salt"], salt);
        assert_eq!(body["backup_version"], 1);
    });
}

#[test]
fn test_key_backup_version_increments() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_ver", "alice_ver@example.com").await;

        let salt = BASE64.encode([0x22u8; 16]);

        // First upload → version 1
        let status = alice
            .put_authed_status(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": BASE64.encode(b"backup-v1"),
                    "key_derivation_salt": salt,
                }),
            )
            .await;
        assert_eq!(status, 204);

        let (_, body) = alice.get_authed("/users/me/key-backup").await;
        assert_eq!(body["backup_version"], 1);

        // Second upload → version 2
        let status = alice
            .put_authed_status(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": BASE64.encode(b"backup-v2"),
                    "key_derivation_salt": salt,
                }),
            )
            .await;
        assert_eq!(status, 204);

        let (_, body) = alice.get_authed("/users/me/key-backup").await;
        assert_eq!(body["backup_version"], 2);
        assert_eq!(body["encrypted_backup"], BASE64.encode(b"backup-v2"));
    });
}

#[test]
fn test_delete_key_backup() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_del", "alice_del@example.com").await;

        let salt = BASE64.encode([0x33u8; 16]);

        // Upload then delete
        alice
            .put_authed_status(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": BASE64.encode(b"to-delete"),
                    "key_derivation_salt": salt,
                }),
            )
            .await;

        let status = alice.delete_authed("/users/me/key-backup").await;
        assert_eq!(status, 204);

        // Fetch after delete → 404
        let (status, _) = alice.get_authed("/users/me/key-backup").await;
        assert_eq!(status, 404);
    });
}

// ────────────────────────────────────────────────────────────
//  Identity Reset Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_identity_reset_allows_new_master_key() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_reset", "alice_reset@example.com").await;

        let signed_list = BASE64.encode(b"device-list-v1");
        let mvk1 = BASE64.encode([0xAAu8; 32]);
        let mvk2 = BASE64.encode([0xBBu8; 32]); // Different key
        let signature = BASE64.encode([0xCCu8; 64]);

        // Upload initial device list
        let status = alice
            .put_authed_status(
                "/users/me/device-list",
                &json!({
                    "signed_list": signed_list,
                    "master_verify_key": mvk1,
                    "signature": signature,
                }),
            )
            .await;
        assert_eq!(status, 204);

        // Upload backup too
        alice
            .put_authed_status(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": BASE64.encode(b"old-backup"),
                    "key_derivation_salt": BASE64.encode([0x11u8; 16]),
                }),
            )
            .await;

        // Trying mvk2 should fail (TOFU)
        let (status, _) = alice
            .put_authed(
                "/users/me/device-list",
                &json!({
                    "signed_list": signed_list,
                    "master_verify_key": mvk2,
                    "signature": signature,
                }),
            )
            .await;
        assert_eq!(status, 403);

        // Reset identity
        let status = alice.delete_authed("/users/me/identity").await;
        assert_eq!(status, 204);

        // Now mvk2 should succeed (TOFU reset)
        let status = alice
            .put_authed_status(
                "/users/me/device-list",
                &json!({
                    "signed_list": signed_list,
                    "master_verify_key": mvk2,
                    "signature": signature,
                }),
            )
            .await;
        assert_eq!(status, 204);

        // Old backup should also be gone
        let (status, _) = alice.get_authed("/users/me/key-backup").await;
        assert_eq!(status, 404);
    });
}

#[test]
fn test_identity_reset_no_identity_returns_404() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_no_id", "alice_no_id@example.com").await;

        // No identity uploaded yet
        let status = alice.delete_authed("/users/me/identity").await;
        assert_eq!(status, 404);
    });
}

// ────────────────────────────────────────────────────────────
//  Backup Size Limit Tests
// ────────────────────────────────────────────────────────────

#[test]
fn test_key_backup_rejects_oversized_blob() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_big", "alice_big@example.com").await;

        // Create a backup blob just over 10 MB (after base64 decode)
        let oversized = vec![0xFFu8; 10 * 1024 * 1024 + 1];
        let salt = BASE64.encode([0x55u8; 16]);

        let (status, body) = alice
            .put_authed(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": BASE64.encode(&oversized),
                    "key_derivation_salt": salt,
                }),
            )
            .await;
        assert_eq!(status, 400);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("exceeds maximum size"),
        );
    });
}

#[test]
fn test_key_backup_access_control() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_ac", "alice_ac@example.com").await;
        let bob = register_client(srv, "bob_ac", "bob_ac@example.com").await;

        let salt = BASE64.encode([0x44u8; 16]);

        // Alice uploads a key backup
        alice
            .put_authed_status(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": BASE64.encode(b"alice-secret"),
                    "key_derivation_salt": salt,
                }),
            )
            .await;

        // Bob tries to fetch — /users/me/key-backup resolves to Bob's own backup
        // Bob has no backup, so should get 404 (not Alice's data)
        let (status, _) = bob.get_authed("/users/me/key-backup").await;
        assert_eq!(status, 404);

        // Alice can still fetch her own backup
        let (status, body) = alice.get_authed("/users/me/key-backup").await;
        assert_eq!(status, 200);
        assert_eq!(body["encrypted_backup"], BASE64.encode(b"alice-secret"));
    });
}
