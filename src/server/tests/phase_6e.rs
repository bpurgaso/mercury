mod common;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use common::{
    make_signed_device_list, resign_device_list, setup, valid_backup_blob, TestServer,
};
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

// TESTSPEC: API-046
// TESTSPEC: API-047
#[test]
fn test_upload_and_fetch_device_list() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_dl", "alice_dl@example.com").await;
        let bob = register_client(srv, "bob_dl", "bob_dl@example.com").await;

        let dl = make_signed_device_list(&[("dev-1", "key-1")]);

        // Alice uploads her device list
        let status = alice
            .put_authed_status("/users/me/device-list", &dl.body)
            .await;
        assert_eq!(status, 204);

        // Bob fetches Alice's device list
        let alice_id = alice.user_id.as_ref().unwrap();
        let (status, body) = bob
            .get_authed(&format!("/users/{alice_id}/device-list"))
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["signed_list"], dl.body["signed_list"]);
        assert_eq!(body["master_verify_key"], dl.body["master_verify_key"]);
        assert_eq!(body["signature"], dl.body["signature"]);
    });
}

// TESTSPEC: API-046
#[test]
fn test_device_list_tofu_violation() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_tofu", "alice_tofu@example.com").await;

        // First upload succeeds (TOFU — establishes the key)
        let dl1 = make_signed_device_list(&[("dev-1", "key-1")]);
        let status = alice
            .put_authed_status("/users/me/device-list", &dl1.body)
            .await;
        assert_eq!(status, 204);

        // Second upload with DIFFERENT master_verify_key → rejected
        let dl2 = make_signed_device_list(&[("dev-1", "key-1")]);
        assert_ne!(dl1.master_verify_key, dl2.master_verify_key);
        let (status, body) = alice
            .put_authed("/users/me/device-list", &dl2.body)
            .await;
        assert_eq!(status, 403);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("trust-on-first-use"),
        );

        // Same key still works (update with re-signed list)
        let updated_body = resign_device_list(&dl1.pkcs8, &[("dev-2", "key-2")]);
        let status = alice
            .put_authed_status("/users/me/device-list", &updated_body)
            .await;
        assert_eq!(status, 204);
    });
}

// ────────────────────────────────────────────────────────────
//  Key Backup Tests
// ────────────────────────────────────────────────────────────

// TESTSPEC: API-049
// TESTSPEC: API-050
#[test]
fn test_upload_and_fetch_key_backup() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_kb", "alice_kb@example.com").await;

        let (encrypted_backup, salt) = valid_backup_blob(b"encrypted-backup-blob");

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

// TESTSPEC: API-051
#[test]
fn test_key_backup_version_increments() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_ver", "alice_ver@example.com").await;

        let (backup_v1, salt) = valid_backup_blob(b"backup-v1");

        // First upload → version 1
        let status = alice
            .put_authed_status(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": backup_v1,
                    "key_derivation_salt": salt,
                }),
            )
            .await;
        assert_eq!(status, 204);

        let (_, body) = alice.get_authed("/users/me/key-backup").await;
        assert_eq!(body["backup_version"], 1);

        // Second upload → version 2
        let (backup_v2, salt2) = valid_backup_blob(b"backup-v2");
        let status = alice
            .put_authed_status(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": backup_v2,
                    "key_derivation_salt": salt2,
                }),
            )
            .await;
        assert_eq!(status, 204);

        let (_, body) = alice.get_authed("/users/me/key-backup").await;
        assert_eq!(body["backup_version"], 2);
        assert_eq!(body["encrypted_backup"], backup_v2);
    });
}

// TESTSPEC: API-052
#[test]
fn test_delete_key_backup() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_del", "alice_del@example.com").await;

        let (backup, salt) = valid_backup_blob(b"to-delete");

        // Upload then delete
        alice
            .put_authed_status(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": backup,
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

// TESTSPEC: API-046
// TESTSPEC: API-052
#[test]
fn test_identity_reset_allows_new_master_key() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_reset", "alice_reset@example.com").await;

        // Upload initial device list
        let dl1 = make_signed_device_list(&[("dev-1", "key-1")]);
        let status = alice
            .put_authed_status("/users/me/device-list", &dl1.body)
            .await;
        assert_eq!(status, 204);

        // Upload backup too
        let (backup, salt) = valid_backup_blob(b"old-backup");
        alice
            .put_authed_status(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": backup,
                    "key_derivation_salt": salt,
                }),
            )
            .await;

        // Trying a different key should fail (TOFU)
        let dl2 = make_signed_device_list(&[("dev-1", "key-1")]);
        let (status, _) = alice
            .put_authed("/users/me/device-list", &dl2.body)
            .await;
        assert_eq!(status, 403);

        // Reset identity
        let status = alice.delete_authed("/users/me/identity").await;
        assert_eq!(status, 204);

        // Now a new key should succeed (TOFU reset)
        let dl3 = make_signed_device_list(&[("dev-1", "key-1")]);
        let status = alice
            .put_authed_status("/users/me/device-list", &dl3.body)
            .await;
        assert_eq!(status, 204);

        // Old backup should also be gone
        let (status, _) = alice.get_authed("/users/me/key-backup").await;
        assert_eq!(status, 404);
    });
}

// TESTSPEC: API-046
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

// TESTSPEC: API-049
#[test]
fn test_key_backup_rejects_oversized_blob() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_big", "alice_big@example.com").await;

        // Create a backup blob just over 10 MB (after base64 decode)
        let oversized = vec![0xFFu8; 10 * 1024 * 1024 + 1];
        let salt = BASE64.encode([0x55u8; 32]);

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

// TESTSPEC: API-050
// TESTSPEC: API-053
#[test]
fn test_key_backup_access_control() {
    let srv = server();
    runtime().block_on(async {
        setup(srv).await;
        let alice = register_client(srv, "alice_ac", "alice_ac@example.com").await;
        let bob = register_client(srv, "bob_ac", "bob_ac@example.com").await;

        let (backup, salt) = valid_backup_blob(b"alice-secret");

        // Alice uploads a key backup
        alice
            .put_authed_status(
                "/users/me/key-backup",
                &json!({
                    "encrypted_backup": backup,
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
        assert_eq!(body["encrypted_backup"], backup);
    });
}
