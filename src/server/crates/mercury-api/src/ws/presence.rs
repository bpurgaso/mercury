use std::sync::Arc;

use fred::prelude::*;
use mercury_core::ids::UserId;
use serde::{Deserialize, Serialize};

use super::manager::ConnectionManager;
use super::protocol::{PresenceUpdateEvent, ServerEvent, ServerMessage};

/// Filter a list of connected user IDs to exclude those who have blocked `target_user`.
async fn filter_blocked(
    redis: &RedisClient,
    connected_users: &[UserId],
    target_user: UserId,
) -> Vec<UserId> {
    let mut filtered = Vec::with_capacity(connected_users.len());
    for uid in connected_users {
        if *uid == target_user {
            filtered.push(*uid);
            continue;
        }
        if !mercury_moderation::blocks::is_blocked(redis, *uid, target_user).await {
            filtered.push(*uid);
        }
    }
    filtered
}

/// Presence data stored in Redis under `presence:{user_id}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceData {
    pub status: String,
    pub last_seen: i64,
    pub connected_devices: Vec<String>,
}

/// TTL for presence keys in Redis (refreshed by heartbeat).
const PRESENCE_TTL_SECS: i64 = 300;

/// TTL for the offline debounce key.
const OFFLINE_DEBOUNCE_SECS: i64 = 15;

/// Set user presence to online and broadcast immediately.
///
/// Per spec §5.4: "Online transitions are immediate — when a user connects,
/// the PRESENCE_UPDATE { status: online } event is broadcast without delay."
pub async fn set_online(
    redis: &RedisClient,
    manager: &ConnectionManager,
    user_id: UserId,
    device_id: &str,
) -> Result<(), RedisError> {
    let key = format!("presence:{}", user_id);

    // Check if there was a pending offline — cancel it silently
    let debounce_key = format!("presence_offline_pending:{}", user_id);
    let _: i64 = redis.del(&debounce_key).await?;

    // Get current presence data or create new
    let mut presence = get_presence(redis, &user_id).await?.unwrap_or(PresenceData {
        status: "online".to_string(),
        last_seen: chrono::Utc::now().timestamp(),
        connected_devices: Vec::new(),
    });

    // Add device if not already present
    let device = device_id.to_string();
    if !presence.connected_devices.contains(&device) {
        presence.connected_devices.push(device);
    }
    presence.status = "online".to_string();
    presence.last_seen = chrono::Utc::now().timestamp();

    let json = serde_json::to_string(&presence)
        .map_err(|e| RedisError::new(RedisErrorKind::Parse, e.to_string()))?;
    redis
        .set::<(), _, _>(
            &key,
            json.as_str(),
            Some(Expiration::EX(PRESENCE_TTL_SECS)),
            None,
            false,
        )
        .await?;

    // Broadcast online event to connected users (excluding those who blocked this user)
    let event = ServerMessage {
        t: ServerEvent::PRESENCE_UPDATE,
        d: serde_json::to_value(PresenceUpdateEvent {
            user_id: user_id.to_string(),
            status: "online".to_string(),
        })
        .unwrap_or_default(),
        seq: None,
    };

    let connected_users = manager.connected_user_ids();
    let recipients = filter_blocked(redis, &connected_users, user_id).await;
    manager.send_to_users(&recipients, &event);

    Ok(())
}

/// Begin the offline debounce sequence on disconnect.
///
/// Per spec §5.4: On disconnect, SET `presence_offline_pending:{user_id}` with
/// 15s TTL. Do NOT update the presence key yet. Do NOT broadcast offline yet.
/// If the user resumes within 15s, the key is deleted silently (flap absorbed).
///
/// A delayed task fires after 16s to check if the debounce expired. If it did
/// and the user hasn't reconnected, update presence to offline and broadcast.
pub async fn begin_offline_debounce(
    redis: &RedisClient,
    manager: Arc<ConnectionManager>,
    user_id: UserId,
    device_id: &str,
) -> Result<(), RedisError> {
    // Check the in-memory ConnectionManager (remove_connection was already called
    // by cleanup_connection before this function). Only start debounce when ALL
    // of the user's devices have disconnected.
    if manager.is_user_connected(&user_id) {
        tracing::debug!(
            "presence debounce: user {user_id} still has other connections (device {device_id} dropped), skipping"
        );
        return Ok(());
    }

    // Per spec §5.4: SET debounce key with 15s TTL. Do NOT touch presence key.
    let debounce_key = format!("presence_offline_pending:{}", user_id);
    tracing::debug!("presence debounce: setting {debounce_key} with {OFFLINE_DEBOUNCE_SECS}s TTL");
    redis
        .set::<(), _, _>(
            &debounce_key,
            "1",
            Some(Expiration::EX(OFFLINE_DEBOUNCE_SECS)),
            None,
            false,
        )
        .await?;

    // Spawn a delayed task to finalize offline after debounce window
    let redis_clone = redis.clone();
    let manager_clone = manager.clone();
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_secs(
            OFFLINE_DEBOUNCE_SECS as u64 + 1,
        ))
        .await;

        // Check if the debounce key has expired (15s passed without reconnect)
        let debounce_key = format!("presence_offline_pending:{}", user_id);
        let exists: bool = redis_clone
            .exists(&debounce_key)
            .await
            .unwrap_or(false);

        // If key expired and user hasn't reconnected, finalize offline
        if !exists && !manager_clone.is_user_connected(&user_id) {
            tracing::debug!("presence debounce: expired for user {user_id}, finalizing offline");
            if let Err(e) =
                finalize_offline(&redis_clone, &manager_clone, user_id).await
            {
                tracing::warn!("failed to finalize offline for {user_id}: {e}");
            }
        } else {
            tracing::debug!(
                "presence debounce: user {user_id} reconnected (flap absorbed), key_exists={exists}"
            );
        }
    });

    Ok(())
}

/// Refresh presence TTL (called on heartbeat).
pub async fn refresh_presence(redis: &RedisClient, user_id: &UserId) -> Result<(), RedisError> {
    let key = format!("presence:{}", user_id);
    let _: bool = redis.expire(&key, PRESENCE_TTL_SECS).await?;
    Ok(())
}

/// Update a user's presence status (e.g., idle, dnd).
pub async fn update_status(
    redis: &RedisClient,
    manager: &ConnectionManager,
    user_id: UserId,
    status: &str,
) -> Result<(), RedisError> {
    let key = format!("presence:{}", user_id);
    if let Some(mut presence) = get_presence(redis, &user_id).await? {
        presence.status = status.to_string();
        presence.last_seen = chrono::Utc::now().timestamp();

        let json = serde_json::to_string(&presence)
            .map_err(|e| RedisError::new(RedisErrorKind::Parse, e.to_string()))?;
        redis
            .set::<(), _, _>(
                &key,
                json.as_str(),
                Some(Expiration::EX(PRESENCE_TTL_SECS)),
                None,
                false,
            )
            .await?;

        // Broadcast presence change (excluding users who blocked this user)
        let event = ServerMessage {
            t: ServerEvent::PRESENCE_UPDATE,
            d: serde_json::to_value(PresenceUpdateEvent {
                user_id: user_id.to_string(),
                status: status.to_string(),
            })
            .unwrap_or_default(),
            seq: None,
        };

        let connected_users = manager.connected_user_ids();
        let recipients = filter_blocked(redis, &connected_users, user_id).await;
        manager.send_to_users(&recipients, &event);
    }

    Ok(())
}

/// Get presence data from Redis.
pub async fn get_presence(
    redis: &RedisClient,
    user_id: &UserId,
) -> Result<Option<PresenceData>, RedisError> {
    let key = format!("presence:{}", user_id);
    let value: Option<String> = redis.get(&key).await?;
    match value {
        Some(json) => {
            let data: PresenceData = serde_json::from_str(&json)
                .map_err(|e| RedisError::new(RedisErrorKind::Parse, e.to_string()))?;
            Ok(Some(data))
        }
        None => Ok(None),
    }
}

/// Finalize an offline transition: update presence and broadcast.
async fn finalize_offline(
    redis: &RedisClient,
    manager: &ConnectionManager,
    user_id: UserId,
) -> Result<(), RedisError> {
    let key = format!("presence:{}", user_id);

    // Update presence to offline
    if let Some(mut presence) = get_presence(redis, &user_id).await? {
        presence.status = "offline".to_string();
        presence.last_seen = chrono::Utc::now().timestamp();
        presence.connected_devices.clear();

        let json = serde_json::to_string(&presence)
            .map_err(|e| RedisError::new(RedisErrorKind::Parse, e.to_string()))?;
        redis
            .set::<(), _, _>(
                &key,
                json.as_str(),
                Some(Expiration::EX(PRESENCE_TTL_SECS)),
                None,
                false,
            )
            .await?;
    }

    // Broadcast offline event (excluding users who blocked this user)
    let event = ServerMessage {
        t: ServerEvent::PRESENCE_UPDATE,
        d: serde_json::to_value(PresenceUpdateEvent {
            user_id: user_id.to_string(),
            status: "offline".to_string(),
        })
        .unwrap_or_default(),
        seq: None,
    };

    let connected_users = manager.connected_user_ids();
    let recipients = filter_blocked(redis, &connected_users, user_id).await;
    manager.send_to_users(&recipients, &event);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ws::manager::ConnectionHandle;
    use tokio::sync::mpsc;

    /// Verify presence data serialization round-trip.
    #[test]
    fn presence_data_serde_roundtrip() {
        let data = PresenceData {
            status: "online".to_string(),
            last_seen: 1700000000,
            connected_devices: vec!["device1".into(), "device2".into()],
        };

        let json = serde_json::to_string(&data).unwrap();
        let parsed: PresenceData = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.status, "online");
        assert_eq!(parsed.last_seen, 1700000000);
        assert_eq!(parsed.connected_devices.len(), 2);
    }

    /// Verify the debounce timing constants match spec §5.4.
    #[test]
    fn debounce_timing_constants() {
        assert_eq!(OFFLINE_DEBOUNCE_SECS, 15, "offline debounce must be 15s per spec §5.4");
        assert_eq!(PRESENCE_TTL_SECS, 300, "presence TTL must be 5min");
    }

    /// Verify that the connection manager correctly tracks whether a user is connected,
    /// which is the core logic that determines whether the debounce cancels (flap absorption).
    #[test]
    fn debounce_flap_absorption_logic() {
        let manager = ConnectionManager::new();
        let user_id = mercury_core::ids::UserId::new();

        // User not connected — debounce should proceed to offline
        assert!(!manager.is_user_connected(&user_id));

        // User connects — debounce should be cancelled (flap absorbed)
        let (tx, _rx) = mpsc::unbounded_channel();
        manager.add_connection(ConnectionHandle {
            session_id: "sess-1".into(),
            device_id: "dev-1".into(),
            user_id,
            tx,
        });
        assert!(manager.is_user_connected(&user_id));

        // User disconnects — debounce timer starts
        manager.remove_connection("sess-1");
        assert!(!manager.is_user_connected(&user_id));

        // User reconnects within window — flap absorbed
        let (tx2, _rx2) = mpsc::unbounded_channel();
        manager.add_connection(ConnectionHandle {
            session_id: "sess-2".into(),
            device_id: "dev-1".into(),
            user_id,
            tx: tx2,
        });
        assert!(manager.is_user_connected(&user_id));
    }

    /// Verify multi-device presence: offline debounce only starts when ALL devices
    /// disconnect, not when a single device drops.
    #[test]
    fn multi_device_presence_tracking() {
        let manager = ConnectionManager::new();
        let user_id = mercury_core::ids::UserId::new();

        // Connect two devices
        let (tx1, _rx1) = mpsc::unbounded_channel();
        let (tx2, _rx2) = mpsc::unbounded_channel();
        manager.add_connection(ConnectionHandle {
            session_id: "sess-1".into(),
            device_id: "phone".into(),
            user_id,
            tx: tx1,
        });
        manager.add_connection(ConnectionHandle {
            session_id: "sess-2".into(),
            device_id: "desktop".into(),
            user_id,
            tx: tx2,
        });

        assert!(manager.is_user_connected(&user_id));

        // Disconnect one device — user still connected
        manager.remove_connection("sess-1");
        assert!(
            manager.is_user_connected(&user_id),
            "user should still be connected with one device"
        );

        // Disconnect second device — now offline debounce should start
        manager.remove_connection("sess-2");
        assert!(
            !manager.is_user_connected(&user_id),
            "user should be disconnected after all devices dropped"
        );
    }

    /// Verify event fan-out reaches connected users.
    #[test]
    fn presence_event_fan_out() {
        let manager = ConnectionManager::new();
        let user_a = mercury_core::ids::UserId::new();
        let user_b = mercury_core::ids::UserId::new();

        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();

        manager.add_connection(ConnectionHandle {
            session_id: "sess-a".into(),
            device_id: "dev-a".into(),
            user_id: user_a,
            tx: tx_a,
        });
        manager.add_connection(ConnectionHandle {
            session_id: "sess-b".into(),
            device_id: "dev-b".into(),
            user_id: user_b,
            tx: tx_b,
        });

        // Send presence event to all connected users
        let event = ServerMessage {
            t: ServerEvent::PRESENCE_UPDATE,
            d: serde_json::json!({"user_id": "test", "status": "online"}),
            seq: None,
        };

        let all_users = manager.connected_user_ids();
        manager.send_to_users(&all_users, &event);

        // Both users should receive the event
        assert!(rx_a.try_recv().is_ok(), "user A should receive the event");
        assert!(rx_b.try_recv().is_ok(), "user B should receive the event");
    }
}
