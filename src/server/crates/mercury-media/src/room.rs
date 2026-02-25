use std::collections::HashMap;
use std::time::Duration;

use chrono::Utc;
use mercury_core::ids::{ChannelId, ServerId, UserId};
use tokio::sync::mpsc;

use crate::types::*;

// ── Room & Participant ─────────────────────────────────────

pub struct Room {
    pub room_id: String,
    pub channel_id: ChannelId,
    pub server_id: Option<ServerId>,
    pub participants: HashMap<UserId, Participant>,
    pub created_at: chrono::DateTime<Utc>,
}

pub struct Participant {
    pub user_id: UserId,
    pub device_id: String,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub joined_at: chrono::DateTime<Utc>,
}

// ── Room Manager ───────────────────────────────────────────

pub struct RoomManager {
    rooms_by_id: HashMap<String, Room>,
    rooms_by_channel: HashMap<ChannelId, String>,
    /// Which room a user is currently in: user_id → room_id.
    user_rooms: HashMap<UserId, String>,
    max_participants: usize,
    empty_room_timeout: Duration,
    event_tx: mpsc::Sender<SfuEvent>,
}

impl RoomManager {
    pub fn new(
        max_participants: usize,
        empty_room_timeout: Duration,
        event_tx: mpsc::Sender<SfuEvent>,
    ) -> Self {
        Self {
            rooms_by_id: HashMap::new(),
            rooms_by_channel: HashMap::new(),
            user_rooms: HashMap::new(),
            max_participants,
            empty_room_timeout,
            event_tx,
        }
    }

    /// Join a user to a room for the given channel. Creates the room if needed.
    pub async fn join(
        &mut self,
        user_id: UserId,
        device_id: String,
        channel_id: ChannelId,
        server_id: Option<ServerId>,
    ) -> Result<JoinResult, SfuError> {
        // If user is already in another room, leave it first
        if let Some(current_room_id) = self.user_rooms.get(&user_id).cloned() {
            let current_room = self.rooms_by_id.get(&current_room_id);
            if let Some(room) = current_room {
                if room.channel_id == channel_id {
                    // Already in this room
                    let participants = room
                        .participants
                        .values()
                        .map(|p| ParticipantInfo {
                            user_id: p.user_id.to_string(),
                            self_mute: p.self_mute,
                            self_deaf: p.self_deaf,
                        })
                        .collect();
                    return Ok(JoinResult {
                        room_id: current_room_id,
                        is_new_room: false,
                        participants,
                    });
                }
            }
            // Leave old room
            self.leave_internal(user_id).await;
        }

        // Find or create room for this channel
        let is_new_room;
        let room_id = if let Some(rid) = self.rooms_by_channel.get(&channel_id) {
            is_new_room = false;
            rid.clone()
        } else {
            is_new_room = true;
            let rid = uuid::Uuid::now_v7().to_string();
            let room = Room {
                room_id: rid.clone(),
                channel_id,
                server_id,
                participants: HashMap::new(),
                created_at: Utc::now(),
            };
            self.rooms_by_id.insert(rid.clone(), room);
            self.rooms_by_channel.insert(channel_id, rid.clone());
            rid
        };

        // Check capacity
        let room = self
            .rooms_by_id
            .get(&room_id)
            .ok_or(SfuError::Internal("room disappeared".into()))?;
        if room.participants.len() >= self.max_participants {
            return Err(SfuError::RoomFull);
        }

        // Add participant
        let room = self.rooms_by_id.get_mut(&room_id).unwrap();
        room.participants.insert(
            user_id,
            Participant {
                user_id,
                device_id,
                self_mute: false,
                self_deaf: false,
                joined_at: Utc::now(),
            },
        );
        self.user_rooms.insert(user_id, room_id.clone());

        // Emit CallStarted if this is a new room
        if is_new_room {
            let _ = self
                .event_tx
                .send(SfuEvent::CallStarted {
                    room_id: room_id.clone(),
                    channel_id,
                    initiator_id: user_id,
                    server_id,
                })
                .await;
        }

        // Emit VoiceStateUpdate for the joining user
        let _ = self
            .event_tx
            .send(SfuEvent::VoiceStateUpdate {
                user_id,
                channel_id,
                self_mute: false,
                self_deaf: false,
                server_id,
            })
            .await;

        let room = self.rooms_by_id.get(&room_id).unwrap();
        let participants = room
            .participants
            .values()
            .map(|p| ParticipantInfo {
                user_id: p.user_id.to_string(),
                self_mute: p.self_mute,
                self_deaf: p.self_deaf,
            })
            .collect();

        Ok(JoinResult {
            room_id,
            is_new_room,
            participants,
        })
    }

    /// Leave the current room.
    pub async fn leave(&mut self, user_id: UserId, _channel_id: ChannelId) {
        self.leave_internal(user_id).await;
    }

    /// Leave any room the user is in.
    pub async fn leave_all(&mut self, user_id: UserId) {
        self.leave_internal(user_id).await;
    }

    /// Internal leave logic.
    async fn leave_internal(&mut self, user_id: UserId) {
        let room_id = match self.user_rooms.remove(&user_id) {
            Some(rid) => rid,
            None => return,
        };

        let (channel_id, server_id, room_empty) = {
            let room = match self.rooms_by_id.get_mut(&room_id) {
                Some(r) => r,
                None => return,
            };
            room.participants.remove(&user_id);
            (room.channel_id, room.server_id, room.participants.is_empty())
        };

        // Emit leave voice state (channel_id present so broadcast knows the channel)
        let _ = self
            .event_tx
            .send(SfuEvent::ParticipantLeft {
                user_id,
                channel_id,
                server_id,
            })
            .await;

        if room_empty {
            // Schedule room destruction after timeout
            let timeout = self.empty_room_timeout;
            if timeout.is_zero() {
                // Immediate cleanup (for tests)
                self.destroy_room(&room_id).await;
            } else {
                // For now, we'll handle timeout via the command loop
                // Just destroy immediately and let the event signal it
                self.destroy_room(&room_id).await;
            }
        }
    }

    async fn destroy_room(&mut self, room_id: &str) {
        if let Some(room) = self.rooms_by_id.remove(room_id) {
            self.rooms_by_channel.remove(&room.channel_id);
            // Clean up any remaining user mappings
            for uid in room.participants.keys() {
                self.user_rooms.remove(uid);
            }
            let _ = self
                .event_tx
                .send(SfuEvent::CallEnded {
                    room_id: room_id.to_string(),
                    channel_id: room.channel_id,
                    server_id: room.server_id,
                })
                .await;
        }
    }

    /// Update mute/deaf state.
    pub async fn update_voice_state(
        &mut self,
        user_id: UserId,
        _channel_id: ChannelId,
        self_mute: bool,
        self_deaf: bool,
    ) {
        let room_id = match self.user_rooms.get(&user_id) {
            Some(rid) => rid.clone(),
            None => return,
        };

        let room = match self.rooms_by_id.get_mut(&room_id) {
            Some(r) => r,
            None => return,
        };

        if let Some(participant) = room.participants.get_mut(&user_id) {
            participant.self_mute = self_mute;
            participant.self_deaf = self_deaf;
        }

        let _ = self
            .event_tx
            .send(SfuEvent::VoiceStateUpdate {
                user_id,
                channel_id: room.channel_id,
                self_mute,
                self_deaf,
                server_id: room.server_id,
            })
            .await;
    }

    /// Handle a WebRTC signal. For this phase, return a placeholder SDP answer
    /// for offers, and relay ICE candidates.
    pub async fn handle_signal(
        &self,
        user_id: UserId,
        room_id: &str,
        signal: WebRtcSignalData,
    ) -> Result<Option<WebRtcSignalData>, SfuError> {
        let room = self
            .rooms_by_id
            .get(room_id)
            .ok_or(SfuError::RoomNotFound)?;

        // Verify user is in this room
        if !room.participants.contains_key(&user_id) {
            return Err(SfuError::NotInRoom);
        }

        match signal.signal_type.as_str() {
            "offer" => {
                // Return a placeholder SDP answer for this phase
                Ok(Some(WebRtcSignalData {
                    signal_type: "answer".to_string(),
                    sdp: Some("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n".to_string()),
                    candidate: None,
                }))
            }
            "ice_candidate" => {
                // Relay ICE candidates to all other participants in the room
                for (&other_user_id, _) in &room.participants {
                    if other_user_id != user_id {
                        let _ = self
                            .event_tx
                            .send(SfuEvent::WebRtcSignal {
                                target_user: other_user_id,
                                from_user: user_id,
                                signal: signal.clone(),
                            })
                            .await;
                    }
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    /// Get room info by room_id.
    pub fn get_room(&self, room_id: &str) -> Option<RoomInfo> {
        self.rooms_by_id.get(room_id).map(|room| RoomInfo {
            room_id: room.room_id.clone(),
            channel_id: room.channel_id.to_string(),
            participants: room
                .participants
                .values()
                .map(|p| ParticipantInfo {
                    user_id: p.user_id.to_string(),
                    self_mute: p.self_mute,
                    self_deaf: p.self_deaf,
                })
                .collect(),
            started_at: room.created_at.to_rfc3339(),
        })
    }

    /// Get room info by channel_id.
    pub fn get_room_by_channel(&self, channel_id: ChannelId) -> Option<RoomInfo> {
        self.rooms_by_channel
            .get(&channel_id)
            .and_then(|rid| self.get_room(rid))
    }
}
