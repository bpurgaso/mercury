mod common;

use common::{setup, TestServer};
use serde_json::json;
use std::time::Duration;

// TESTSPEC: DB-001
#[tokio::test]
async fn migrations_run_cleanly() {
    let server = TestServer::start().await;
    setup(&server).await;

    let row: (i32,) = sqlx::query_as("SELECT 1 as val")
        .fetch_one(&server.db)
        .await
        .expect("DB should be healthy after migrations");
    assert_eq!(row.0, 1);
}

// TESTSPEC: DB-006
#[tokio::test]
async fn server_invite_code_unique() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Create two servers via API — invite codes should be auto-generated and unique
    let mut alice = server.client();
    alice
        .register_raw("db006_alice", "db006_alice@test.com", "password123")
        .await;

    let (status1, srv1) = alice
        .post_authed("/servers", &json!({"name": "server-one"}))
        .await;
    assert_eq!(status1, 201, "first server creation should succeed");
    let invite1 = srv1["invite_code"].as_str().expect("server should have invite_code");

    let (status2, srv2) = alice
        .post_authed("/servers", &json!({"name": "server-two"}))
        .await;
    assert_eq!(status2, 201, "second server creation should succeed");
    let invite2 = srv2["invite_code"].as_str().expect("server should have invite_code");

    assert_ne!(
        invite1, invite2,
        "two servers must have different invite codes"
    );

    // Verify the UNIQUE constraint at the DB level: inserting a duplicate invite_code should fail
    let user_id: (uuid::Uuid,) =
        sqlx::query_as("SELECT id FROM users WHERE username = 'db006_alice'")
            .fetch_one(&server.db)
            .await
            .unwrap();

    let duplicate_result = sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) \
         VALUES ($1, 'dup-server', $2, $3)",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(user_id.0)
    .bind(invite1)
    .execute(&server.db)
    .await;

    assert!(
        duplicate_result.is_err(),
        "inserting a duplicate invite_code should violate the UNIQUE constraint"
    );
}

// TESTSPEC: DB-010
#[tokio::test]
async fn channel_unique_name_per_server() {
    let server = TestServer::start().await;
    setup(&server).await;

    let mut alice = server.client();
    alice
        .register_raw("db010_alice", "db010_alice@test.com", "password123")
        .await;

    let (_, srv) = alice
        .post_authed("/servers", &json!({"name": "unique-ch-test"}))
        .await;
    let server_id = srv["id"].as_str().unwrap();

    // Create first channel
    let (status1, _) = alice
        .post_authed(
            &format!("/servers/{server_id}/channels"),
            &json!({"name": "general", "encryption_mode": "standard"}),
        )
        .await;
    assert_eq!(status1, 201, "first channel creation should succeed");

    // Try to create another channel with the same name in the same server
    let (status2, _) = alice
        .post_authed(
            &format!("/servers/{server_id}/channels"),
            &json!({"name": "general", "encryption_mode": "standard"}),
        )
        .await;
    assert!(
        status2 == 409 || status2 == 400 || status2 == 500,
        "duplicate channel name in same server should be rejected, got {status2}"
    );

    // Verify that a different server CAN have a channel with the same name
    let (_, srv2) = alice
        .post_authed("/servers", &json!({"name": "other-server"}))
        .await;
    let server_id2 = srv2["id"].as_str().unwrap();

    let (status3, _) = alice
        .post_authed(
            &format!("/servers/{server_id2}/channels"),
            &json!({"name": "general", "encryption_mode": "standard"}),
        )
        .await;
    assert_eq!(
        status3, 201,
        "same channel name in a different server should succeed"
    );
}

// TESTSPEC: DB-013
#[tokio::test]
async fn message_channel_or_dm_constraint() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Set up prerequisite rows: user, server, channel, dm_channel
    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db013_user', 'DB013', 'db013@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) \
         VALUES ($1, 'db013-srv', $2, 'DB013INV')",
    )
    .bind(srv_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let channel_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type) \
         VALUES ($1, $2, 'test-ch', 'text')",
    )
    .bind(channel_id)
    .bind(srv_id)
    .execute(&server.db)
    .await
    .unwrap();

    let dm_channel_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO dm_channels (id) VALUES ($1)")
        .bind(dm_channel_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Case 1: Both channel_id and dm_channel_id set — should FAIL
    let both_set = sqlx::query(
        "INSERT INTO messages (id, channel_id, dm_channel_id, sender_id, content) \
         VALUES ($1, $2, $3, $4, 'test')",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(channel_id)
    .bind(dm_channel_id)
    .bind(user_id)
    .execute(&server.db)
    .await;
    assert!(
        both_set.is_err(),
        "message with both channel_id and dm_channel_id should fail CHECK constraint"
    );

    // Case 2: Neither channel_id nor dm_channel_id set — should FAIL
    let neither_set = sqlx::query(
        "INSERT INTO messages (id, channel_id, dm_channel_id, sender_id, content) \
         VALUES ($1, NULL, NULL, $2, 'test')",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(user_id)
    .execute(&server.db)
    .await;
    assert!(
        neither_set.is_err(),
        "message with neither channel_id nor dm_channel_id should fail CHECK constraint"
    );

    // Case 3: Only channel_id set — should SUCCEED
    let channel_only = sqlx::query(
        "INSERT INTO messages (id, channel_id, dm_channel_id, sender_id, content) \
         VALUES ($1, $2, NULL, $3, 'test')",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(channel_id)
    .bind(user_id)
    .execute(&server.db)
    .await;
    assert!(
        channel_only.is_ok(),
        "message with only channel_id should succeed"
    );

    // Case 4: Only dm_channel_id set — should SUCCEED
    let dm_only = sqlx::query(
        "INSERT INTO messages (id, channel_id, dm_channel_id, sender_id, content) \
         VALUES ($1, NULL, $2, $3, 'test')",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(dm_channel_id)
    .bind(user_id)
    .execute(&server.db)
    .await;
    assert!(
        dm_only.is_ok(),
        "message with only dm_channel_id should succeed"
    );
}

// TESTSPEC: DB-014
#[tokio::test]
async fn message_recipients_per_device() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Test the message_recipients schema directly via SQL:
    // Verify per-device ciphertext rows can be stored and the UNIQUE constraint works.
    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db014_user', 'DB014', 'db014@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) VALUES ($1, 'db014-srv', $2, 'DB014INV')",
    )
    .bind(srv_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let channel_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type, encryption_mode) \
         VALUES ($1, $2, 'private-ch', 'text', 'private')",
    )
    .bind(channel_id)
    .bind(srv_id)
    .execute(&server.db)
    .await
    .unwrap();

    let msg_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, sender_id) VALUES ($1, $2, $3)",
    )
    .bind(msg_id)
    .bind(channel_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Create device rows (required by FK constraint)
    let device_a = uuid::Uuid::now_v7();
    let device_b = uuid::Uuid::now_v7();
    for (dev_id, name) in [(device_a, "device-a"), (device_b, "device-b")] {
        sqlx::query("INSERT INTO devices (id, user_id, device_name) VALUES ($1, $2, $3)")
            .bind(dev_id)
            .bind(user_id)
            .bind(name)
            .execute(&server.db)
            .await
            .unwrap();
    }

    sqlx::query(
        "INSERT INTO message_recipients (message_id, device_id, ciphertext) VALUES ($1, $2, $3)",
    )
    .bind(msg_id)
    .bind(device_a)
    .bind(&[10u8, 20, 30, 40][..])
    .execute(&server.db)
    .await
    .expect("per-device recipient row should insert");

    sqlx::query(
        "INSERT INTO message_recipients (message_id, device_id, ciphertext) VALUES ($1, $2, $3)",
    )
    .bind(msg_id)
    .bind(device_b)
    .bind(&[50u8, 60, 70, 80][..])
    .execute(&server.db)
    .await
    .expect("second per-device recipient row should insert");

    // Verify both rows exist
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM message_recipients WHERE message_id = $1",
    )
    .bind(msg_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 2, "should have 2 per-device recipient rows");

    // Verify UNIQUE(message_id, device_id) constraint
    let dup = sqlx::query(
        "INSERT INTO message_recipients (message_id, device_id, ciphertext) VALUES ($1, $2, $3)",
    )
    .bind(msg_id)
    .bind(device_a)
    .bind(&[99u8][..])
    .execute(&server.db)
    .await;
    assert!(dup.is_err(), "duplicate (message_id, device_id) should violate UNIQUE constraint");
}

// TESTSPEC: DB-015
#[tokio::test]
async fn message_recipients_broadcast() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Test the broadcast (Sender Key) pattern directly via SQL:
    // device_id = NULL means the ciphertext is decryptable by any member with the sender key.
    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db015_user', 'DB015', 'db015@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) VALUES ($1, 'db015-srv', $2, 'DB015INV')",
    )
    .bind(srv_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let channel_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type, encryption_mode) \
         VALUES ($1, $2, 'broadcast-ch', 'text', 'private')",
    )
    .bind(channel_id)
    .bind(srv_id)
    .execute(&server.db)
    .await
    .unwrap();

    let msg_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, sender_id) VALUES ($1, $2, $3)",
    )
    .bind(msg_id)
    .bind(channel_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Insert broadcast recipient row (device_id = NULL for Sender Key)
    sqlx::query(
        "INSERT INTO message_recipients (message_id, device_id, ciphertext) VALUES ($1, NULL, $2)",
    )
    .bind(msg_id)
    .bind(&[99u8, 88, 77][..])
    .execute(&server.db)
    .await
    .expect("broadcast recipient row (device_id NULL) should insert");

    // Verify the broadcast row exists
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM message_recipients WHERE message_id = $1 AND device_id IS NULL",
    )
    .bind(msg_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 1, "should have exactly 1 broadcast recipient row");

    // Can also have per-device rows alongside broadcast
    let device_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO devices (id, user_id, device_name) VALUES ($1, $2, 'test-device')")
        .bind(device_id)
        .bind(user_id)
        .execute(&server.db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO message_recipients (message_id, device_id, ciphertext) VALUES ($1, $2, $3)",
    )
    .bind(msg_id)
    .bind(device_id)
    .bind(&[11u8, 22][..])
    .execute(&server.db)
    .await
    .expect("per-device row alongside broadcast should also work");

    let total: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM message_recipients WHERE message_id = $1",
    )
    .bind(msg_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(total.0, 2, "should have broadcast + per-device = 2 rows total");
}

// TESTSPEC: DB-029
#[tokio::test]
async fn cascade_delete_server() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Create all data via direct SQL for precise control
    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db029_user', 'DB029', 'db029@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) \
         VALUES ($1, 'cascade-test', $2, 'CASC001')",
    )
    .bind(srv_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Add server member
    sqlx::query("INSERT INTO server_members (user_id, server_id) VALUES ($1, $2)")
        .bind(user_id)
        .bind(srv_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Create channel
    let channel_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type) \
         VALUES ($1, $2, 'general', 'text')",
    )
    .bind(channel_id)
    .bind(srv_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Create message in the channel
    let msg_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, sender_id, content) \
         VALUES ($1, $2, $3, 'hello cascade')",
    )
    .bind(msg_id)
    .bind(channel_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Verify data exists before delete
    let channel_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM channels WHERE server_id = $1")
            .bind(srv_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(channel_count.0, 1, "channel should exist before delete");

    let member_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM server_members WHERE server_id = $1")
            .bind(srv_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(member_count.0, 1, "member should exist before delete");

    let msg_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM messages WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(msg_count.0, 1, "message should exist before delete");

    // Delete the server
    sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(srv_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Verify all related rows are cascade-deleted
    let channel_count_after: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM channels WHERE server_id = $1")
            .bind(srv_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(
        channel_count_after.0, 0,
        "channels should be cascade-deleted when server is deleted"
    );

    let member_count_after: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM server_members WHERE server_id = $1")
            .bind(srv_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(
        member_count_after.0, 0,
        "server_members should be cascade-deleted when server is deleted"
    );

    let msg_count_after: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM messages WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(
        msg_count_after.0, 0,
        "messages should be cascade-deleted when server (and its channels) are deleted"
    );
}

// TESTSPEC: DB-002
#[tokio::test]
async fn user_crud_full_cycle() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Create user via direct SQL
    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db002_user', 'Original Name', 'db002@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Read by ID
    let row: (String, String) = sqlx::query_as(
        "SELECT username, display_name FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(row.0, "db002_user");
    assert_eq!(row.1, "Original Name");

    // Update display_name
    let updated = sqlx::query(
        "UPDATE users SET display_name = 'Updated Name' WHERE id = $1",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();
    assert_eq!(updated.rows_affected(), 1);

    let row: (String,) = sqlx::query_as(
        "SELECT display_name FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(row.0, "Updated Name");

    // Delete
    let deleted = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&server.db)
        .await
        .unwrap();
    assert_eq!(deleted.rows_affected(), 1);

    // Verify gone
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(count.0, 0, "user should be deleted");
}

// TESTSPEC: DB-005
#[tokio::test]
async fn server_crud_cascade_delete() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db005_user', 'DB005', 'db005@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) \
         VALUES ($1, 'cascade-srv', $2, 'DB005INV')",
    )
    .bind(srv_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Read server
    let row: (String,) = sqlx::query_as("SELECT name FROM servers WHERE id = $1")
        .bind(srv_id)
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(row.0, "cascade-srv");

    // Update name
    sqlx::query("UPDATE servers SET name = 'updated-srv' WHERE id = $1")
        .bind(srv_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Add member and channel
    sqlx::query("INSERT INTO server_members (user_id, server_id) VALUES ($1, $2)")
        .bind(user_id)
        .bind(srv_id)
        .execute(&server.db)
        .await
        .unwrap();

    let ch_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type) \
         VALUES ($1, $2, 'general', 'text')",
    )
    .bind(ch_id)
    .bind(srv_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Delete server → cascade should remove channels and members
    sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(srv_id)
        .execute(&server.db)
        .await
        .unwrap();

    let ch_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM channels WHERE server_id = $1")
            .bind(srv_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(ch_count.0, 0, "channels should be cascade-deleted");

    let mem_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM server_members WHERE server_id = $1")
            .bind(srv_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(mem_count.0, 0, "server_members should be cascade-deleted");
}

// TESTSPEC: DB-008
#[tokio::test]
async fn channel_encryption_mode_immutable() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db008_user', 'DB008', 'db008@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Create server + standard channel via API to test PATCH behavior
    let mut client = server.client();
    client
        .register_raw("db008_owner", "db008_owner@test.com", "password123")
        .await;

    let (_, srv) = client
        .post_authed("/servers", &json!({"name": "immut-test"}))
        .await;
    let server_id = srv["id"].as_str().unwrap();

    let (_, ch) = client
        .post_authed(
            &format!("/servers/{server_id}/channels"),
            &json!({"name": "std-ch", "encryption_mode": "standard"}),
        )
        .await;
    let channel_id = ch["id"].as_str().unwrap();

    // Attempt to PATCH encryption_mode from standard → private
    let (status, _) = client
        .patch_authed(
            &format!("/channels/{channel_id}"),
            &json!({"encryption_mode": "private"}),
        )
        .await;

    // The PATCH handler only supports updating `name`, so encryption_mode should be unchanged
    // Verify it's still standard
    let (_, channels_body) = client
        .get_authed(&format!("/servers/{server_id}/channels"))
        .await;
    let channels = channels_body.as_array().unwrap();
    let ch = channels
        .iter()
        .find(|c| c["id"].as_str() == Some(channel_id))
        .expect("channel should exist");
    assert_eq!(
        ch["encryption_mode"].as_str().unwrap_or(""),
        "standard",
        "encryption_mode must remain standard after PATCH attempt"
    );
}

// TESTSPEC: DB-009
#[tokio::test]
async fn channel_private_max_members_101_rejected() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db009_user', 'DB009', 'db009@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) VALUES ($1, 'db009-srv', $2, 'DB009INV')",
    )
    .bind(srv_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Private channel with max_members=100 should succeed
    let ok = sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type, encryption_mode, max_members) \
         VALUES ($1, $2, 'ok-ch', 'text', 'private', 100)",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(srv_id)
    .execute(&server.db)
    .await;
    assert!(ok.is_ok(), "private channel with max_members=100 should succeed");

    // Private channel with max_members=101 should fail CHECK constraint
    let fail = sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type, encryption_mode, max_members) \
         VALUES ($1, $2, 'bad-ch', 'text', 'private', 101)",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(srv_id)
    .execute(&server.db)
    .await;
    assert!(
        fail.is_err(),
        "private channel with max_members=101 should violate CHECK constraint"
    );
}

// TESTSPEC: DB-016
#[tokio::test]
async fn dm_channel_crud() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Create two users
    let user_a = uuid::Uuid::now_v7();
    let user_b = uuid::Uuid::now_v7();
    for (uid, name, email) in [
        (user_a, "db016_a", "db016_a@test.com"),
        (user_b, "db016_b", "db016_b@test.com"),
    ] {
        sqlx::query(
            "INSERT INTO users (id, username, display_name, email, password_hash) \
             VALUES ($1, $2, $2, $3, 'hash')",
        )
        .bind(uid)
        .bind(name)
        .bind(email)
        .execute(&server.db)
        .await
        .unwrap();
    }

    // Create DM channel
    let dm_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO dm_channels (id) VALUES ($1)")
        .bind(dm_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Add both members
    for uid in [user_a, user_b] {
        sqlx::query("INSERT INTO dm_members (dm_channel_id, user_id) VALUES ($1, $2)")
            .bind(dm_id)
            .bind(uid)
            .execute(&server.db)
            .await
            .unwrap();
    }

    // Count members
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM dm_members WHERE dm_channel_id = $1",
    )
    .bind(dm_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 2, "DM channel should have 2 members");

    // List DMs for user_a
    let dms: Vec<(uuid::Uuid,)> = sqlx::query_as(
        "SELECT dm_channel_id FROM dm_members WHERE user_id = $1",
    )
    .bind(user_a)
    .fetch_all(&server.db)
    .await
    .unwrap();
    assert_eq!(dms.len(), 1, "user_a should see 1 DM channel");
    assert_eq!(dms[0].0, dm_id);
}

// TESTSPEC: DB-030
#[tokio::test]
async fn pool_acquire_timeout() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Verify the pool is functional by acquiring a connection and running a query
    let conn = server
        .db
        .acquire()
        .await
        .expect("pool should allow connection acquisition");
    drop(conn);

    // Double-check by running a real query through the pool
    let row: (i32,) = sqlx::query_as("SELECT 42 as val")
        .fetch_one(&server.db)
        .await
        .expect("pool should serve queries without timeout");
    assert_eq!(row.0, 42, "query through pool should return correct result");
}
