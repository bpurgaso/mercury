use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use mercury_core::ids::UserId;
use tokio::sync::mpsc;

use super::protocol::{EncodedServerMessage, ServerMessage};

/// Maximum number of events buffered per session for replay on resume.
const EVENT_BUFFER_CAPACITY: usize = 1000;

/// Handle to a single WebSocket connection.
/// Used to send events to a connected client.
pub struct ConnectionHandle {
    pub session_id: String,
    pub device_id: String,
    pub user_id: UserId,
    pub tx: mpsc::UnboundedSender<EncodedServerMessage>,
}

/// In-memory state for a session, supporting resume after disconnect.
pub struct SessionState {
    pub user_id: UserId,
    pub device_id: String,
    pub jwt_jti: String,
    /// Next sequence number to assign.
    next_seq: AtomicU64,
    /// Ring buffer of recent events for replay on resume.
    /// Stores (seq, encoded_bytes) — bytes can be JSON text or MessagePack binary.
    event_buffer: parking_lot::Mutex<VecDeque<(u64, BufferedEvent)>>,
}

/// A buffered event for replay — can be either JSON text or MessagePack binary.
#[derive(Clone)]
pub enum BufferedEvent {
    Text(String),
    Binary(Vec<u8>),
}

impl SessionState {
    pub fn new(user_id: UserId, device_id: String, jwt_jti: String) -> Self {
        Self {
            user_id,
            device_id,
            jwt_jti,
            next_seq: AtomicU64::new(1),
            event_buffer: parking_lot::Mutex::new(VecDeque::with_capacity(EVENT_BUFFER_CAPACITY)),
        }
    }

    /// Allocate the next sequence number.
    pub fn next_seq(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::Relaxed)
    }

    /// Current sequence number (last assigned).
    pub fn current_seq(&self) -> u64 {
        self.next_seq.load(Ordering::Relaxed).saturating_sub(1)
    }

    /// Buffer an event for potential replay.
    pub fn buffer_event(&self, seq: u64, event: BufferedEvent) {
        let mut buf = self.event_buffer.lock();
        if buf.len() >= EVENT_BUFFER_CAPACITY {
            buf.pop_front();
        }
        buf.push_back((seq, event));
    }

    /// Get all events after the given sequence number for replay.
    pub fn events_since(&self, last_seq: u64) -> Vec<BufferedEvent> {
        let buf = self.event_buffer.lock();
        buf.iter()
            .filter(|(seq, _)| *seq > last_seq)
            .map(|(_, event)| event.clone())
            .collect()
    }
}

/// Manages all active WebSocket connections and sessions.
///
/// Provides:
/// - Per-user connection tracking for event fan-out
/// - Session state for resume support
/// - Event buffering for replay after disconnect/reconnect
pub struct ConnectionManager {
    /// user_id → list of active connection handles in this process.
    connections: DashMap<UserId, Vec<ConnectionHandle>>,
    /// session_id → session state (survives brief disconnects for resume).
    sessions: DashMap<String, Arc<SessionState>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: DashMap::new(),
            sessions: DashMap::new(),
        }
    }

    /// Register a new connection for a user.
    pub fn add_connection(&self, handle: ConnectionHandle) {
        let user_id = handle.user_id;
        self.connections
            .entry(user_id)
            .or_default()
            .push(handle);
    }

    /// Remove a connection by session_id. Returns the user_id if found.
    pub fn remove_connection(&self, session_id: &str) -> Option<UserId> {
        let mut found_user = None;

        // Iterate all users to find the connection with this session_id
        self.connections.retain(|user_id, conns| {
            let before = conns.len();
            conns.retain(|c| c.session_id != session_id);
            if conns.len() < before {
                found_user = Some(*user_id);
            }
            !conns.is_empty()
        });

        found_user
    }

    /// Check if a user has any active connections.
    pub fn is_user_connected(&self, user_id: &UserId) -> bool {
        self.connections
            .get(user_id)
            .map(|conns| !conns.is_empty())
            .unwrap_or(false)
    }

    /// Create and store a new session.
    pub fn create_session(
        &self,
        session_id: String,
        user_id: UserId,
        device_id: String,
        jwt_jti: String,
    ) -> Arc<SessionState> {
        let state = Arc::new(SessionState::new(user_id, device_id, jwt_jti));
        self.sessions.insert(session_id, state.clone());
        state
    }

    /// Get an existing session by ID (for resume).
    pub fn get_session(&self, session_id: &str) -> Option<Arc<SessionState>> {
        self.sessions.get(session_id).map(|s| s.clone())
    }

    /// Remove a session.
    pub fn remove_session(&self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    /// Send a JSON text event to all connections of a specific user.
    pub fn send_to_user(&self, user_id: &UserId, message: &ServerMessage) {
        if let Some(conns) = self.connections.get(user_id) {
            for conn in conns.iter() {
                let _ = conn.tx.send(EncodedServerMessage::Text(message.clone()));
            }
        }
    }

    /// Send a JSON text event to all connections of multiple users.
    pub fn send_to_users(&self, user_ids: &[UserId], message: &ServerMessage) {
        for user_id in user_ids {
            self.send_to_user(user_id, message);
        }
    }

    /// Send a pre-encoded binary event to a specific device by device_id.
    /// Searches all connections for a matching device_id.
    pub fn send_binary_to_device(&self, device_id: &str, bytes: &[u8]) {
        for entry in self.connections.iter() {
            for conn in entry.value().iter() {
                if conn.device_id == device_id {
                    let _ = conn.tx.send(EncodedServerMessage::Binary(bytes.to_vec()));
                }
            }
        }
    }

    /// Send a pre-encoded binary event to all connections of multiple users.
    pub fn send_binary_to_users(&self, user_ids: &[UserId], bytes: &[u8]) {
        for user_id in user_ids {
            if let Some(conns) = self.connections.get(user_id) {
                for conn in conns.iter() {
                    let _ = conn.tx.send(EncodedServerMessage::Binary(bytes.to_vec()));
                }
            }
        }
    }

    /// Send a pre-encoded binary event to all devices of a user EXCEPT a specific device.
    pub fn send_binary_to_user_except_device(
        &self,
        user_id: &UserId,
        exclude_device_id: &str,
        bytes: &[u8],
    ) {
        if let Some(conns) = self.connections.get(user_id) {
            for conn in conns.iter() {
                if conn.device_id != exclude_device_id {
                    let _ = conn.tx.send(EncodedServerMessage::Binary(bytes.to_vec()));
                }
            }
        }
    }

    /// Get all currently connected user IDs.
    pub fn connected_user_ids(&self) -> Vec<UserId> {
        self.connections
            .iter()
            .map(|entry| *entry.key())
            .collect()
    }
}
