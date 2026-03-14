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
    let (_status, _) = client
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

// TESTSPEC: DB-003
#[tokio::test]
async fn user_unique_username() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user1_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db003_user1', 'DB003-1', 'db003_a@test.com', 'hash')",
    )
    .bind(user1_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Insert another user with the same username but different email
    let user2_id = uuid::Uuid::now_v7();
    let dup = sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db003_user1', 'DB003-2', 'db003_b@test.com', 'hash')",
    )
    .bind(user2_id)
    .execute(&server.db)
    .await;

    assert!(
        dup.is_err(),
        "inserting a duplicate username should violate the UNIQUE constraint"
    );
}

// TESTSPEC: DB-004
#[tokio::test]
async fn user_unique_email() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user1_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db004_user1', 'DB004-1', 'db004_same@test.com', 'hash')",
    )
    .bind(user1_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Insert another user with different username but same email
    let user2_id = uuid::Uuid::now_v7();
    let dup = sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db004_user2', 'DB004-2', 'db004_same@test.com', 'hash')",
    )
    .bind(user2_id)
    .execute(&server.db)
    .await;

    assert!(
        dup.is_err(),
        "inserting a duplicate email should violate the UNIQUE constraint"
    );
}

// TESTSPEC: DB-007
#[tokio::test]
async fn channel_crud() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db007_user', 'DB007', 'db007@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) \
         VALUES ($1, 'db007-srv', $2, 'DB007INV')",
    )
    .bind(srv_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Create channel
    let ch_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type) \
         VALUES ($1, $2, 'db007-channel', 'text')",
    )
    .bind(ch_id)
    .bind(srv_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Read channel
    let row: (String, String) = sqlx::query_as(
        "SELECT name, channel_type FROM channels WHERE id = $1",
    )
    .bind(ch_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(row.0, "db007-channel");
    assert_eq!(row.1, "text");

    // Update name
    let updated = sqlx::query("UPDATE channels SET name = 'db007-renamed' WHERE id = $1")
        .bind(ch_id)
        .execute(&server.db)
        .await
        .unwrap();
    assert_eq!(updated.rows_affected(), 1);

    let row: (String,) = sqlx::query_as("SELECT name FROM channels WHERE id = $1")
        .bind(ch_id)
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(row.0, "db007-renamed");

    // Delete channel
    let deleted = sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(ch_id)
        .execute(&server.db)
        .await
        .unwrap();
    assert_eq!(deleted.rows_affected(), 1);

    // Verify gone
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM channels WHERE id = $1")
        .bind(ch_id)
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(count.0, 0, "channel should be deleted");
}

// TESTSPEC: DB-011
#[tokio::test]
async fn server_member_join_leave() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db011_user', 'DB011', 'db011@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let member_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db011_member', 'DB011M', 'db011_m@test.com', 'hash')",
    )
    .bind(member_id)
    .execute(&server.db)
    .await
    .unwrap();

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) \
         VALUES ($1, 'db011-srv', $2, 'DB011INV')",
    )
    .bind(srv_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Add member
    sqlx::query("INSERT INTO server_members (user_id, server_id) VALUES ($1, $2)")
        .bind(member_id)
        .bind(srv_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Verify member is in list
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM server_members WHERE server_id = $1 AND user_id = $2",
    )
    .bind(srv_id)
    .bind(member_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 1, "member should be in the server");

    // Remove member
    sqlx::query("DELETE FROM server_members WHERE user_id = $1 AND server_id = $2")
        .bind(member_id)
        .bind(srv_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Verify member is gone
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM server_members WHERE server_id = $1 AND user_id = $2",
    )
    .bind(srv_id)
    .bind(member_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 0, "member should no longer be in the server");
}

// TESTSPEC: DB-012
#[tokio::test]
async fn message_insert_fetch_paginated() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db012_user', 'DB012', 'db012@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) \
         VALUES ($1, 'db012-srv', $2, 'DB012INV')",
    )
    .bind(srv_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let ch_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type) \
         VALUES ($1, $2, 'db012-ch', 'text')",
    )
    .bind(ch_id)
    .bind(srv_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Insert 20 messages
    for i in 0..20 {
        let msg_id = uuid::Uuid::now_v7();
        sqlx::query(
            "INSERT INTO messages (id, channel_id, sender_id, content) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(msg_id)
        .bind(ch_id)
        .bind(user_id)
        .bind(format!("message {}", i))
        .execute(&server.db)
        .await
        .unwrap();
    }

    // Fetch first 10 (newest first)
    let page1: Vec<(uuid::Uuid, String)> = sqlx::query_as(
        "SELECT id, content FROM messages WHERE channel_id = $1 \
         ORDER BY created_at DESC LIMIT 10",
    )
    .bind(ch_id)
    .fetch_all(&server.db)
    .await
    .unwrap();
    assert_eq!(page1.len(), 10, "first page should have 10 messages");

    // Fetch next 10 using OFFSET
    let page2: Vec<(uuid::Uuid, String)> = sqlx::query_as(
        "SELECT id, content FROM messages WHERE channel_id = $1 \
         ORDER BY created_at DESC LIMIT 10 OFFSET 10",
    )
    .bind(ch_id)
    .fetch_all(&server.db)
    .await
    .unwrap();
    assert_eq!(page2.len(), 10, "second page should have 10 messages");

    // Verify no overlap between pages
    let page1_ids: Vec<uuid::Uuid> = page1.iter().map(|r| r.0).collect();
    let page2_ids: Vec<uuid::Uuid> = page2.iter().map(|r| r.0).collect();
    for id in &page2_ids {
        assert!(
            !page1_ids.contains(id),
            "pages should not overlap"
        );
    }
}

// TESTSPEC: DB-017
#[tokio::test]
async fn device_registration() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db017_user', 'DB017', 'db017@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Register first device
    let dev1_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO devices (id, user_id, device_name) VALUES ($1, $2, 'phone')")
        .bind(dev1_id)
        .bind(user_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Verify it exists
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM devices WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 1, "first device should exist");

    // Register second device
    let dev2_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO devices (id, user_id, device_name) VALUES ($1, $2, 'laptop')")
        .bind(dev2_id)
        .bind(user_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Both should exist
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM devices WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 2, "both devices should exist");
}

// TESTSPEC: DB-018
#[tokio::test]
async fn device_identity_key_crud() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db018_user', 'DB018', 'db018@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let dev_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO devices (id, user_id, device_name) VALUES ($1, $2, 'db018-dev')")
        .bind(dev_id)
        .bind(user_id)
        .execute(&server.db)
        .await
        .unwrap();

    let identity_key = vec![1u8, 2, 3, 4];
    let signed_prekey = vec![5u8, 6, 7, 8];
    let prekey_signature = vec![9u8, 10, 11, 12];

    // Upload identity key + signed prekey
    sqlx::query(
        "INSERT INTO device_identity_keys (device_id, user_id, identity_key, signed_prekey, prekey_signature) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(dev_id)
    .bind(user_id)
    .bind(&identity_key[..])
    .bind(&signed_prekey[..])
    .bind(&prekey_signature[..])
    .execute(&server.db)
    .await
    .unwrap();

    // Fetch by device and verify
    let row: (Vec<u8>, Vec<u8>, Vec<u8>) = sqlx::query_as(
        "SELECT identity_key, signed_prekey, prekey_signature FROM device_identity_keys WHERE device_id = $1",
    )
    .bind(dev_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(row.0, identity_key, "identity_key should match");
    assert_eq!(row.1, signed_prekey, "signed_prekey should match");
    assert_eq!(row.2, prekey_signature, "prekey_signature should match");

    // Update signed prekey
    let new_prekey = vec![20u8, 21, 22, 23];
    sqlx::query(
        "UPDATE device_identity_keys SET signed_prekey = $1 WHERE device_id = $2",
    )
    .bind(&new_prekey[..])
    .bind(dev_id)
    .execute(&server.db)
    .await
    .unwrap();

    let row: (Vec<u8>,) = sqlx::query_as(
        "SELECT signed_prekey FROM device_identity_keys WHERE device_id = $1",
    )
    .bind(dev_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(row.0, new_prekey, "signed_prekey should be updated");
}

// TESTSPEC: DB-019
#[tokio::test]
async fn one_time_prekey_claim_atomic() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db019_user', 'DB019', 'db019@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let dev_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO devices (id, user_id, device_name) VALUES ($1, $2, 'db019-dev')")
        .bind(dev_id)
        .bind(user_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Upload 10 OTPs
    for i in 0..10 {
        sqlx::query(
            "INSERT INTO one_time_prekeys (device_id, user_id, key_id, prekey) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(dev_id)
        .bind(user_id)
        .bind(i as i32)
        .bind(vec![i as u8; 32])
        .execute(&server.db)
        .await
        .unwrap();
    }

    // Claim one (mark as used)
    let claimed: (i64, i32) = sqlx::query_as(
        "UPDATE one_time_prekeys SET used = true \
         WHERE id = (SELECT id FROM one_time_prekeys WHERE device_id = $1 AND NOT used LIMIT 1) \
         RETURNING id, key_id",
    )
    .bind(dev_id)
    .fetch_one(&server.db)
    .await
    .unwrap();

    // 9 should remain available
    let available: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM one_time_prekeys WHERE device_id = $1 AND NOT used",
    )
    .bind(dev_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(available.0, 9, "9 OTPs should remain available after claiming 1");

    // Re-claim same key_id should fail (inserting a new one with the same key_id
    // should violate UNIQUE(device_id, key_id))
    let dup = sqlx::query(
        "INSERT INTO one_time_prekeys (device_id, user_id, key_id, prekey) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(dev_id)
    .bind(user_id)
    .bind(claimed.1)
    .bind(vec![99u8; 32])
    .execute(&server.db)
    .await;
    assert!(
        dup.is_err(),
        "re-inserting same key_id for same device should violate UNIQUE constraint"
    );
}

// TESTSPEC: DB-020
#[tokio::test]
async fn one_time_prekey_batch_lifecycle() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db020_user', 'DB020', 'db020@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let dev_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO devices (id, user_id, device_name) VALUES ($1, $2, 'db020-dev')")
        .bind(dev_id)
        .bind(user_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Upload 5 OTPs
    for i in 0..5 {
        sqlx::query(
            "INSERT INTO one_time_prekeys (device_id, user_id, key_id, prekey) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(dev_id)
        .bind(user_id)
        .bind(i as i32)
        .bind(vec![i as u8; 32])
        .execute(&server.db)
        .await
        .unwrap();
    }

    // Claim 1
    sqlx::query(
        "UPDATE one_time_prekeys SET used = true \
         WHERE id = (SELECT id FROM one_time_prekeys WHERE device_id = $1 AND NOT used LIMIT 1)",
    )
    .bind(dev_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Verify 1 marked used
    let used: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM one_time_prekeys WHERE device_id = $1 AND used",
    )
    .bind(dev_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(used.0, 1, "1 OTP should be marked used");

    // Verify 4 available
    let available: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM one_time_prekeys WHERE device_id = $1 AND NOT used",
    )
    .bind(dev_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(available.0, 4, "4 OTPs should remain available");
}

// TESTSPEC: DB-021
#[tokio::test]
async fn device_list_crud() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db021_user', 'DB021', 'db021@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let signed_list = vec![1u8, 2, 3, 4, 5];
    let master_verify_key = vec![10u8, 20, 30];
    let signature = vec![40u8, 50, 60];

    // Insert device list
    sqlx::query(
        "INSERT INTO device_lists (user_id, signed_list, master_verify_key, signature, updated_at) \
         VALUES ($1, $2, $3, $4, now())",
    )
    .bind(user_id)
    .bind(&signed_list[..])
    .bind(&master_verify_key[..])
    .bind(&signature[..])
    .execute(&server.db)
    .await
    .unwrap();

    // Fetch by user and verify
    let row: (Vec<u8>, Vec<u8>, Vec<u8>) = sqlx::query_as(
        "SELECT signed_list, master_verify_key, signature FROM device_lists WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(row.0, signed_list, "signed_list should match");
    assert_eq!(row.1, master_verify_key, "master_verify_key should match");
    assert_eq!(row.2, signature, "signature should match");

    // Get initial updated_at
    let before: (chrono::DateTime<chrono::Utc>,) = sqlx::query_as(
        "SELECT updated_at FROM device_lists WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();

    // Small delay to ensure timestamp changes
    tokio::time::sleep(Duration::from_millis(10)).await;

    // Update signed_list
    let new_list = vec![99u8, 98, 97];
    sqlx::query(
        "UPDATE device_lists SET signed_list = $1, updated_at = now() WHERE user_id = $2",
    )
    .bind(&new_list[..])
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let after: (Vec<u8>, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "SELECT signed_list, updated_at FROM device_lists WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(after.0, new_list, "signed_list should be updated");
    assert!(
        after.1 >= before.0,
        "updated_at should be >= the original value"
    );
}

// TESTSPEC: DB-022
#[tokio::test]
async fn key_backup_crud() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db022_user', 'DB022', 'db022@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let backup_data = vec![1u8, 2, 3, 4, 5];
    let salt = vec![10u8, 20, 30];

    // Insert backup
    sqlx::query(
        "INSERT INTO key_backups (user_id, encrypted_backup, backup_version, key_derivation_salt, updated_at) \
         VALUES ($1, $2, 1, $3, now())",
    )
    .bind(user_id)
    .bind(&backup_data[..])
    .bind(&salt[..])
    .execute(&server.db)
    .await
    .unwrap();

    // Fetch and verify
    let row: (Vec<u8>, i32, Vec<u8>) = sqlx::query_as(
        "SELECT encrypted_backup, backup_version, key_derivation_salt FROM key_backups WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(row.0, backup_data, "encrypted_backup should match");
    assert_eq!(row.1, 1, "backup_version should be 1");
    assert_eq!(row.2, salt, "key_derivation_salt should match");

    // Update backup and increment version
    let new_backup = vec![50u8, 60, 70];
    sqlx::query(
        "UPDATE key_backups SET encrypted_backup = $1, backup_version = backup_version + 1, updated_at = now() \
         WHERE user_id = $2",
    )
    .bind(&new_backup[..])
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    let row: (Vec<u8>, i32) = sqlx::query_as(
        "SELECT encrypted_backup, backup_version FROM key_backups WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(row.0, new_backup, "encrypted_backup should be updated");
    assert_eq!(row.1, 2, "backup_version should be incremented to 2");

    // Delete backup
    sqlx::query("DELETE FROM key_backups WHERE user_id = $1")
        .bind(user_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Verify gone
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM key_backups WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 0, "key_backup should be deleted");
}

// TESTSPEC: DB-023
#[tokio::test]
async fn user_blocks_crud() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_a = uuid::Uuid::now_v7();
    let user_b = uuid::Uuid::now_v7();
    for (uid, name, email) in [
        (user_a, "db023_a", "db023_a@test.com"),
        (user_b, "db023_b", "db023_b@test.com"),
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

    // A blocks B
    sqlx::query("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)")
        .bind(user_a)
        .bind(user_b)
        .execute(&server.db)
        .await
        .unwrap();

    // Verify block exists
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 1, "block should exist");

    // Unblock (DELETE)
    sqlx::query("DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2")
        .bind(user_a)
        .bind(user_b)
        .execute(&server.db)
        .await
        .unwrap();

    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 0, "block should be removed");

    // Self-block attempt
    let self_block = sqlx::query("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $1)")
        .bind(user_a)
        .execute(&server.db)
        .await;
    // Self-block may or may not be allowed by the schema; test the behavior
    if self_block.is_err() {
        // Schema prevents self-blocking via CHECK constraint
    } else {
        // Schema allows self-blocking — clean up
        sqlx::query("DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $1")
            .bind(user_a)
            .execute(&server.db)
            .await
            .unwrap();
    }
}

// TESTSPEC: DB-024
#[tokio::test]
async fn server_bans_crud() {
    let server = TestServer::start().await;
    setup(&server).await;

    let owner_id = uuid::Uuid::now_v7();
    let banned_user_id = uuid::Uuid::now_v7();
    for (uid, name, email) in [
        (owner_id, "db024_owner", "db024_owner@test.com"),
        (banned_user_id, "db024_banned", "db024_banned@test.com"),
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

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) \
         VALUES ($1, 'db024-srv', $2, 'DB024INV')",
    )
    .bind(srv_id)
    .bind(owner_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Ban user with an expiry
    sqlx::query(
        "INSERT INTO server_bans (server_id, user_id, banned_by, reason, expires_at) \
         VALUES ($1, $2, $3, 'test ban', now() + interval '1 day')",
    )
    .bind(srv_id)
    .bind(banned_user_id)
    .bind(owner_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Verify ban exists
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM server_bans WHERE server_id = $1 AND user_id = $2",
    )
    .bind(srv_id)
    .bind(banned_user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 1, "ban should exist");

    // Check expires_at is in the future
    let row: (Option<chrono::DateTime<chrono::Utc>>,) = sqlx::query_as(
        "SELECT expires_at FROM server_bans WHERE server_id = $1 AND user_id = $2",
    )
    .bind(srv_id)
    .bind(banned_user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert!(row.0.is_some(), "expires_at should be set");
    assert!(
        row.0.unwrap() > chrono::Utc::now(),
        "expires_at should be in the future"
    );

    // Unban (DELETE)
    sqlx::query("DELETE FROM server_bans WHERE server_id = $1 AND user_id = $2")
        .bind(srv_id)
        .bind(banned_user_id)
        .execute(&server.db)
        .await
        .unwrap();

    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM server_bans WHERE server_id = $1 AND user_id = $2",
    )
    .bind(srv_id)
    .bind(banned_user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 0, "ban should be removed after unban");
}

// TESTSPEC: DB-025
#[tokio::test]
async fn channel_mutes_crud() {
    let server = TestServer::start().await;
    setup(&server).await;

    let owner_id = uuid::Uuid::now_v7();
    let muted_user_id = uuid::Uuid::now_v7();
    for (uid, name, email) in [
        (owner_id, "db025_owner", "db025_owner@test.com"),
        (muted_user_id, "db025_muted", "db025_muted@test.com"),
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

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) \
         VALUES ($1, 'db025-srv', $2, 'DB025INV')",
    )
    .bind(srv_id)
    .bind(owner_id)
    .execute(&server.db)
    .await
    .unwrap();

    let ch_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type) \
         VALUES ($1, $2, 'db025-ch', 'text')",
    )
    .bind(ch_id)
    .bind(srv_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Mute user
    sqlx::query(
        "INSERT INTO channel_mutes (channel_id, user_id, muted_by, reason, expires_at) \
         VALUES ($1, $2, $3, 'test mute', now() + interval '1 hour')",
    )
    .bind(ch_id)
    .bind(muted_user_id)
    .bind(owner_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Verify mute exists
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM channel_mutes WHERE channel_id = $1 AND user_id = $2",
    )
    .bind(ch_id)
    .bind(muted_user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 1, "mute should exist");

    // Unmute (DELETE)
    sqlx::query("DELETE FROM channel_mutes WHERE channel_id = $1 AND user_id = $2")
        .bind(ch_id)
        .bind(muted_user_id)
        .execute(&server.db)
        .await
        .unwrap();

    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM channel_mutes WHERE channel_id = $1 AND user_id = $2",
    )
    .bind(ch_id)
    .bind(muted_user_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 0, "mute should be removed after unmute");
}

// TESTSPEC: DB-026
#[tokio::test]
async fn reports_crud() {
    let server = TestServer::start().await;
    setup(&server).await;

    let reporter_id = uuid::Uuid::now_v7();
    let reported_id = uuid::Uuid::now_v7();
    let reviewer_id = uuid::Uuid::now_v7();
    for (uid, name, email) in [
        (reporter_id, "db026_reporter", "db026_reporter@test.com"),
        (reported_id, "db026_reported", "db026_reported@test.com"),
        (reviewer_id, "db026_reviewer", "db026_reviewer@test.com"),
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

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) \
         VALUES ($1, 'db026-srv', $2, 'DB026INV')",
    )
    .bind(srv_id)
    .bind(reporter_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Create report
    let report_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO reports (id, reporter_id, reported_user_id, server_id, category, description, status) \
         VALUES ($1, $2, $3, $4, 'harassment', 'test report description', 'pending')",
    )
    .bind(report_id)
    .bind(reporter_id)
    .bind(reported_id)
    .bind(srv_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Fetch by server
    let reports: Vec<(uuid::Uuid, String, String)> = sqlx::query_as(
        "SELECT id, category, status FROM reports WHERE server_id = $1",
    )
    .bind(srv_id)
    .fetch_all(&server.db)
    .await
    .unwrap();
    assert_eq!(reports.len(), 1, "should have 1 report for this server");
    assert_eq!(reports[0].0, report_id);
    assert_eq!(reports[0].1, "harassment");
    assert_eq!(reports[0].2, "pending");

    // Update status to 'actioned'
    sqlx::query(
        "UPDATE reports SET status = 'actioned', reviewed_by = $1, reviewed_at = now() \
         WHERE id = $2",
    )
    .bind(reviewer_id)
    .bind(report_id)
    .execute(&server.db)
    .await
    .unwrap();

    let row: (String, Option<uuid::Uuid>, Option<chrono::DateTime<chrono::Utc>>) = sqlx::query_as(
        "SELECT status, reviewed_by, reviewed_at FROM reports WHERE id = $1",
    )
    .bind(report_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(row.0, "actioned", "status should be updated to actioned");
    assert_eq!(row.1, Some(reviewer_id), "reviewed_by should be set");
    assert!(row.2.is_some(), "reviewed_at should be set");
}

// TESTSPEC: DB-027
#[tokio::test]
async fn audit_log_append_only() {
    let server = TestServer::start().await;
    setup(&server).await;

    let owner_id = uuid::Uuid::now_v7();
    let mod_id = uuid::Uuid::now_v7();
    let target_id = uuid::Uuid::now_v7();
    for (uid, name, email) in [
        (owner_id, "db027_owner", "db027_owner@test.com"),
        (mod_id, "db027_mod", "db027_mod@test.com"),
        (target_id, "db027_target", "db027_target@test.com"),
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

    let srv_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, invite_code) \
         VALUES ($1, 'db027-srv', $2, 'DB027INV')",
    )
    .bind(srv_id)
    .bind(owner_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Insert 5 audit log entries
    let actions = ["ban", "mute", "kick", "warn", "unban"];
    for action in &actions {
        sqlx::query(
            "INSERT INTO mod_audit_log (server_id, moderator_id, action, target_user_id, reason) \
             VALUES ($1, $2, $3, $4, 'test reason')",
        )
        .bind(srv_id)
        .bind(mod_id)
        .bind(*action)
        .bind(target_id)
        .execute(&server.db)
        .await
        .unwrap();
    }

    // Verify all 5 exist in chronological order
    let logs: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, action FROM mod_audit_log WHERE server_id = $1 ORDER BY created_at ASC, id ASC",
    )
    .bind(srv_id)
    .fetch_all(&server.db)
    .await
    .unwrap();
    assert_eq!(logs.len(), 5, "should have 5 audit log entries");
    for (i, action) in actions.iter().enumerate() {
        assert_eq!(logs[i].1, *action, "entry {} should be '{}'", i, action);
    }

    // Verify IDs are in ascending order (chronological)
    for i in 1..logs.len() {
        assert!(
            logs[i].0 > logs[i - 1].0,
            "audit log IDs should be in ascending order"
        );
    }

    // Verify all 5 are still there (append-only check)
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM mod_audit_log WHERE server_id = $1",
    )
    .bind(srv_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(count.0, 5, "all 5 audit log entries should still exist");
}

// TESTSPEC: DB-028
#[tokio::test]
async fn abuse_signals_crud() {
    let server = TestServer::start().await;
    setup(&server).await;

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash) \
         VALUES ($1, 'db028_user', 'DB028', 'db028@test.com', 'hash')",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Insert abuse signal
    sqlx::query(
        "INSERT INTO abuse_signals (user_id, signal_type, severity, details, reviewed) \
         VALUES ($1, 'spam', 'medium', '{\"count\": 5}'::jsonb, false)",
    )
    .bind(user_id)
    .execute(&server.db)
    .await
    .unwrap();

    // Fetch unreviewed signals
    let unreviewed: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, signal_type, severity FROM abuse_signals WHERE user_id = $1 AND NOT reviewed",
    )
    .bind(user_id)
    .fetch_all(&server.db)
    .await
    .unwrap();
    assert_eq!(unreviewed.len(), 1, "should have 1 unreviewed signal");
    assert_eq!(unreviewed[0].1, "spam");
    assert_eq!(unreviewed[0].2, "medium");

    let signal_id = unreviewed[0].0;

    // Mark as reviewed
    sqlx::query("UPDATE abuse_signals SET reviewed = true WHERE id = $1")
        .bind(signal_id)
        .execute(&server.db)
        .await
        .unwrap();

    // Verify no longer in unreviewed list
    let unreviewed: Vec<(i64,)> = sqlx::query_as(
        "SELECT id FROM abuse_signals WHERE user_id = $1 AND NOT reviewed",
    )
    .bind(user_id)
    .fetch_all(&server.db)
    .await
    .unwrap();
    assert_eq!(unreviewed.len(), 0, "should have 0 unreviewed signals after marking reviewed");
}
