use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::ids::*;

// ── Users ──────────────────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct User {
    pub id: UserId,
    pub username: String,
    pub display_name: String,
    pub email: String,
    pub password_hash: String,
    pub avatar_url: Option<String>,
    pub status: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

// ── Servers & Channels ─────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Server {
    pub id: ServerId,
    pub name: String,
    pub description: Option<String>,
    pub icon_url: Option<String>,
    pub owner_id: UserId,
    pub invite_code: String,
    pub max_members: Option<i32>,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Channel {
    pub id: ChannelId,
    pub server_id: ServerId,
    pub name: String,
    pub channel_type: String,
    pub encryption_mode: String,
    pub sender_key_epoch: i64,
    pub max_members: Option<i32>,
    pub topic: Option<String>,
    pub position: i32,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct ServerMember {
    pub user_id: UserId,
    pub server_id: ServerId,
    pub nickname: Option<String>,
    pub is_moderator: bool,
    pub joined_at: Option<DateTime<Utc>>,
}

// ── Messages ───────────────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Message {
    pub id: MessageId,
    pub channel_id: Option<ChannelId>,
    pub dm_channel_id: Option<DmChannelId>,
    pub sender_id: UserId,
    pub content: Option<String>,
    pub message_type: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub edited_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct MessageRecipient {
    pub id: i64,
    pub message_id: MessageId,
    pub device_id: Option<DeviceId>,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct DmChannel {
    pub id: DmChannelId,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct DmMember {
    pub dm_channel_id: DmChannelId,
    pub user_id: UserId,
}

// ── Devices & Keys ─────────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Device {
    pub id: DeviceId,
    pub user_id: UserId,
    pub device_name: String,
    pub created_at: Option<DateTime<Utc>>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct DeviceIdentityKey {
    pub device_id: DeviceId,
    pub user_id: UserId,
    pub identity_key: Vec<u8>,
    pub signed_prekey: Vec<u8>,
    pub prekey_signature: Vec<u8>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct OneTimePrekey {
    pub id: i64,
    pub device_id: DeviceId,
    pub user_id: UserId,
    pub key_id: i32,
    pub prekey: Vec<u8>,
    pub used: Option<bool>,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct DeviceList {
    pub user_id: UserId,
    pub signed_list: Vec<u8>,
    pub master_verify_key: Vec<u8>,
    pub signature: Vec<u8>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct KeyBackup {
    pub user_id: UserId,
    pub encrypted_backup: Vec<u8>,
    pub backup_version: i32,
    pub key_derivation_salt: Vec<u8>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

// ── Moderation ─────────────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct UserBlock {
    pub blocker_id: UserId,
    pub blocked_id: UserId,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct ServerBan {
    pub server_id: ServerId,
    pub user_id: UserId,
    pub banned_by: UserId,
    pub reason: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct ChannelMute {
    pub channel_id: ChannelId,
    pub user_id: UserId,
    pub muted_by: UserId,
    pub reason: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Report {
    pub id: ReportId,
    pub reporter_id: UserId,
    pub reported_user_id: UserId,
    pub server_id: Option<ServerId>,
    pub channel_id: Option<ChannelId>,
    pub message_id: Option<MessageId>,
    pub category: String,
    pub description: Option<String>,
    pub evidence_blob: Option<Vec<u8>>,
    pub status: Option<String>,
    pub reviewed_by: Option<UserId>,
    pub reviewed_at: Option<DateTime<Utc>>,
    pub action_taken: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct ModAuditLog {
    pub id: i64,
    pub server_id: ServerId,
    pub moderator_id: UserId,
    pub action: String,
    pub target_user_id: UserId,
    pub target_channel_id: Option<ChannelId>,
    pub reason: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct AbuseSignal {
    pub id: i64,
    pub user_id: UserId,
    pub signal_type: String,
    pub severity: Option<String>,
    pub details: serde_json::Value,
    pub auto_action: Option<String>,
    pub reviewed: Option<bool>,
    pub created_at: Option<DateTime<Utc>>,
}
