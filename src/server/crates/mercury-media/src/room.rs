use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use chrono::Utc;
use mercury_core::ids::{ChannelId, ServerId, UserId};
use str0m::change::SdpOffer;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event as RtcEvent, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::types::*;

// ── Room & Participant ─────────────────────────────────────

pub struct Room {
    pub room_id: String,
    pub channel_id: ChannelId,
    pub server_id: Option<ServerId>,
    pub participants: HashMap<UserId, Participant>,
    pub created_at: chrono::DateTime<Utc>,
    /// Pending delayed-destruction handle; cancelled if someone joins.
    pub cleanup_handle: Option<tokio::task::JoinHandle<()>>,
}

pub struct Participant {
    pub user_id: UserId,
    pub device_id: String,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub joined_at: chrono::DateTime<Utc>,
}

/// Per-participant str0m WebRTC session.
pub struct PeerSession {
    pub rtc: Rtc,
    pub user_id: UserId,
    pub room_id: String,
    pub connected: bool,
    /// Remote addr → this peer mapping for UDP packet routing.
    pub remote_addr: Option<SocketAddr>,
    /// True after the first SDP offer has been accepted. str0m's internal DTLS
    /// layer panics if poll_output() is called before SDP processing initialises
    /// the DTLS state, so we guard all poll_output calls with this flag.
    pub sdp_initialized: bool,
}

// ── Room Manager ───────────────────────────────────────────

pub struct RoomManager {
    rooms_by_id: HashMap<String, Room>,
    rooms_by_channel: HashMap<ChannelId, String>,
    /// Which room a user is currently in: user_id → room_id.
    user_rooms: HashMap<UserId, String>,
    /// Per-user str0m peer sessions: user_id → PeerSession.
    pub peer_sessions: HashMap<UserId, PeerSession>,
    max_participants: usize,
    empty_room_timeout: Duration,
    event_tx: mpsc::Sender<SfuEvent>,
    /// Local address of the SFU UDP socket for ICE candidates.
    local_addr: SocketAddr,
}

impl RoomManager {
    pub fn new(
        max_participants: usize,
        empty_room_timeout: Duration,
        event_tx: mpsc::Sender<SfuEvent>,
        local_addr: SocketAddr,
    ) -> Self {
        Self {
            rooms_by_id: HashMap::new(),
            rooms_by_channel: HashMap::new(),
            user_rooms: HashMap::new(),
            peer_sessions: HashMap::new(),
            max_participants,
            empty_room_timeout,
            event_tx,
            local_addr,
        }
    }

    /// Create a new str0m Rtc instance for a participant.
    fn create_rtc(&self) -> Rtc {
        let mut rtc = Rtc::builder()
            .set_rtp_mode(true)
            .build(Instant::now());

        // Add our SFU's UDP socket as a local ICE candidate.
        // str0m rejects 0.0.0.0 as invalid, so substitute 127.0.0.1 for
        // unspecified addresses (common in tests and single-host deployments).
        let candidate_addr = if self.local_addr.ip().is_unspecified() {
            SocketAddr::new(
                std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                self.local_addr.port(),
            )
        } else {
            self.local_addr
        };
        let candidate = Candidate::host(candidate_addr, "udp")
            .expect("failed to create host candidate");
        rtc.add_local_candidate(candidate);

        rtc
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
            // Cancel any pending cleanup since someone is joining
            if let Some(room) = self.rooms_by_id.get_mut(rid) {
                if let Some(handle) = room.cleanup_handle.take() {
                    handle.abort();
                }
            }
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
                cleanup_handle: None,
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

        // Create str0m peer session
        let rtc = self.create_rtc();
        let peer = PeerSession {
            rtc,
            user_id,
            room_id: room_id.clone(),
            connected: false,
            remote_addr: None,
            sdp_initialized: false,
        };
        self.peer_sessions.insert(user_id, peer);

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

        // Remove peer session
        self.peer_sessions.remove(&user_id);

        let (channel_id, server_id, room_empty) = {
            let room = match self.rooms_by_id.get_mut(&room_id) {
                Some(r) => r,
                None => return,
            };
            room.participants.remove(&user_id);
            (room.channel_id, room.server_id, room.participants.is_empty())
        };

        // Emit leave voice state
        let _ = self
            .event_tx
            .send(SfuEvent::ParticipantLeft {
                user_id,
                channel_id,
                server_id,
            })
            .await;

        if room_empty {
            let timeout = self.empty_room_timeout;
            if timeout.is_zero() {
                // Immediate cleanup (for tests)
                self.destroy_room(&room_id).await;
            } else {
                // Schedule delayed cleanup — if someone joins before the timeout,
                // the cleanup handle is aborted in join().
                let room_id_clone = room_id.clone();
                let event_tx = self.event_tx.clone();

                // We need to destroy the room after the timeout.
                // Store a channel sender that the delayed task can use to request cleanup.
                // For simplicity, destroy the room data now but delay the CallEnded event.
                // Actually, we need to keep the room alive so people can rejoin.
                // So we keep the room but schedule its destruction.

                // Remove room from channel mapping immediately to allow new room creation
                // if someone joins a different way, but keep room_by_id for the timeout period.

                // Simplest approach: spawn a task that sleeps and then sends a cleanup command.
                // We'll use a JoinHandle that we can abort.
                let handle = tokio::spawn(async move {
                    tokio::time::sleep(timeout).await;
                    // Signal cleanup (the event will be consumed by the command loop)
                    let _ = event_tx
                        .send(SfuEvent::CallEnded {
                            room_id: room_id_clone,
                            channel_id,
                            server_id,
                        })
                        .await;
                });

                if let Some(room) = self.rooms_by_id.get_mut(&room_id) {
                    room.cleanup_handle = Some(handle);
                }
            }
        }
    }

    /// Destroy a room immediately (called from delayed cleanup or immediate cleanup).
    pub async fn destroy_room(&mut self, room_id: &str) {
        if let Some(room) = self.rooms_by_id.remove(room_id) {
            self.rooms_by_channel.remove(&room.channel_id);
            // Cancel any pending cleanup
            if let Some(handle) = room.cleanup_handle {
                handle.abort();
            }
            // Clean up any remaining user mappings and peer sessions
            for uid in room.participants.keys() {
                self.user_rooms.remove(uid);
                self.peer_sessions.remove(uid);
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

    /// Destroy room by ID if it is still empty (called from delayed cleanup command).
    pub async fn destroy_room_if_empty(&mut self, room_id: &str) {
        let is_empty = self
            .rooms_by_id
            .get(room_id)
            .map(|r| r.participants.is_empty())
            .unwrap_or(false);
        if is_empty {
            // Remove without emitting CallEnded again (the delayed task already sent it)
            if let Some(room) = self.rooms_by_id.remove(room_id) {
                self.rooms_by_channel.remove(&room.channel_id);
                if let Some(handle) = room.cleanup_handle {
                    handle.abort();
                }
            }
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

    /// Handle a WebRTC signal using str0m.
    /// For SDP offers: creates a real SDP answer via str0m.
    /// For ICE candidates: feeds them to the str0m Rtc instance.
    pub async fn handle_signal(
        &mut self,
        user_id: UserId,
        room_id: &str,
        signal: WebRtcSignalData,
        socket: &UdpSocket,
    ) -> Result<Option<WebRtcSignalData>, SfuError> {
        // Verify room exists and user is in it
        let room = self
            .rooms_by_id
            .get(room_id)
            .ok_or(SfuError::RoomNotFound)?;
        if !room.participants.contains_key(&user_id) {
            return Err(SfuError::NotInRoom);
        }

        match signal.signal_type.as_str() {
            "offer" => {
                let sdp_str = signal
                    .sdp
                    .as_deref()
                    .ok_or_else(|| SfuError::Internal("offer missing sdp".into()))?;

                let offer = SdpOffer::from_sdp_string(sdp_str)
                    .map_err(|e| SfuError::Internal(format!("invalid SDP offer: {e}")))?;

                let peer = self
                    .peer_sessions
                    .get_mut(&user_id)
                    .ok_or_else(|| SfuError::Internal("peer session not found".into()))?;

                // Accept the offer and generate an answer
                let answer = peer
                    .rtc
                    .sdp_api()
                    .accept_offer(offer)
                    .map_err(|e| SfuError::Internal(format!("str0m accept_offer failed: {e}")))?;

                let answer_sdp = answer.to_sdp_string();

                // Mark DTLS as initialized — safe to call poll_output now
                peer.sdp_initialized = true;

                // Drain any outputs (transmit packets, events) after SDP processing
                drain_rtc_outputs(&mut peer.rtc, socket);

                Ok(Some(WebRtcSignalData {
                    signal_type: "answer".to_string(),
                    sdp: Some(answer_sdp),
                    candidate: None,
                }))
            }
            "ice_candidate" => {
                if let Some(candidate_str) = &signal.candidate {
                    let peer = self
                        .peer_sessions
                        .get_mut(&user_id)
                        .ok_or_else(|| SfuError::Internal("peer session not found".into()))?;

                    // Parse and add remote ICE candidate
                    match Candidate::from_sdp_string(candidate_str) {
                        Ok(candidate) => {
                            peer.rtc.add_remote_candidate(candidate);
                            if peer.sdp_initialized {
                                drain_rtc_outputs(&mut peer.rtc, socket);
                            }
                        }
                        Err(e) => {
                            debug!("failed to parse ICE candidate: {e}");
                        }
                    }
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    /// Route an incoming UDP packet to the correct str0m Rtc instance.
    /// Returns true if the packet was consumed by a peer.
    pub fn route_udp_packet(
        &mut self,
        buf: &[u8],
        source: SocketAddr,
        local_addr: SocketAddr,
        socket: &UdpSocket,
    ) -> bool {
        // Build an Input for str0m's accepts() check
        let Ok(contents) = buf.try_into() else {
            return false;
        };

        let input = Input::Receive(
            Instant::now(),
            Receive {
                proto: Protocol::Udp,
                source,
                destination: local_addr,
                contents,
            },
        );

        // Find the peer session that accepts this packet (only SDP-initialized peers)
        let accepting_user = self
            .peer_sessions
            .iter()
            .find(|(_, peer)| peer.sdp_initialized && peer.rtc.accepts(&input))
            .map(|(uid, _)| *uid);

        let Some(user_id) = accepting_user else {
            return false;
        };

        // Feed the packet to the accepting Rtc instance
        let peer = self.peer_sessions.get_mut(&user_id).unwrap();
        let input = Input::Receive(
            Instant::now(),
            Receive {
                proto: Protocol::Udp,
                source,
                destination: local_addr,
                contents: buf.try_into().unwrap(),
            },
        );

        if let Err(e) = peer.rtc.handle_input(input) {
            warn!("rtc handle_input error for user {user_id}: {e}");
        }

        peer.remote_addr = Some(source);

        // Drain outputs and handle media forwarding
        self.drain_and_forward(user_id, socket);

        true
    }

    /// Poll all Rtc instances for timeout-driven events.
    pub fn poll_timeouts(&mut self, socket: &UdpSocket) {
        let user_ids: Vec<UserId> = self.peer_sessions.keys().copied().collect();
        let now = Instant::now();

        for user_id in user_ids {
            if let Some(peer) = self.peer_sessions.get_mut(&user_id) {
                // Skip peers that haven't completed SDP exchange
                if !peer.sdp_initialized {
                    continue;
                }
                // Feed timeout input
                if let Err(e) = peer.rtc.handle_input(Input::Timeout(now)) {
                    warn!("rtc timeout error for user {user_id}: {e}");
                    continue;
                }
            }
            self.drain_and_forward(user_id, socket);
        }
    }

    /// Calculate the earliest timeout across all Rtc instances.
    /// Returns None if there are no active peers (handled by periodic polling).
    pub fn next_timeout(&self) -> Option<Instant> {
        if self.peer_sessions.is_empty() {
            None
        } else {
            // Use periodic polling interval; str0m handles its own internal timeouts
            Some(Instant::now() + Duration::from_millis(50))
        }
    }

    /// Drain outputs from an Rtc instance and forward RTP to other room members.
    fn drain_and_forward(&mut self, user_id: UserId, socket: &UdpSocket) {
        let _room_id = match self.user_rooms.get(&user_id) {
            Some(rid) => rid.clone(),
            None => return,
        };

        // Collect RTP packets to forward to other participants
        let mut has_rtp = false;
        let mut disconnected = false;

        if let Some(peer) = self.peer_sessions.get_mut(&user_id) {
            // Skip peers that haven't processed SDP yet — str0m's internal DTLS
            // layer panics if poll_output is called before SDP initialises DTLS.
            if !peer.sdp_initialized {
                return;
            }
            // str0m requires a timeout input before poll_output
            let _ = peer.rtc.handle_input(Input::Timeout(Instant::now()));
            loop {
                match peer.rtc.poll_output() {
                    Ok(Output::Timeout(_)) => break,
                    Ok(Output::Transmit(t)) => {
                        // Send the packet out via UDP
                        let _ = socket.try_send_to(&t.contents, t.destination);
                    }
                    Ok(Output::Event(event)) => match event {
                        RtcEvent::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                            debug!("peer {user_id} ICE disconnected");
                            disconnected = true;
                        }
                        RtcEvent::RtpPacket(_rtp) => {
                            // RTP packet received from this participant.
                            // In a full SFU, we'd forward this to other participants'
                            // Rtc instances via StreamTx::write_rtp(). For now, we note
                            // that RTP is flowing.
                            has_rtp = true;
                        }
                        RtcEvent::MediaAdded(media) => {
                            debug!("media added for peer {user_id}: mid={}", media.mid);
                            peer.connected = true;
                        }
                        _ => {}
                    },
                    Err(e) => {
                        warn!("rtc poll_output error for user {user_id}: {e}");
                        break;
                    }
                }
            }
        }

        let _ = has_rtp; // RTP forwarding will be refined with full media pipeline

        // Handle disconnect
        if disconnected {
            // Will be handled by the command loop via leave_all
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

/// Drain all pending outputs from an Rtc instance, sending transmits via UDP.
fn drain_rtc_outputs(rtc: &mut Rtc, socket: &UdpSocket) {
    // str0m requires a timeout input before poll_output
    let _ = rtc.handle_input(Input::Timeout(Instant::now()));
    loop {
        match rtc.poll_output() {
            Ok(Output::Timeout(_)) => break,
            Ok(Output::Transmit(t)) => {
                let _ = socket.try_send_to(&t.contents, t.destination);
            }
            Ok(Output::Event(_)) => {
                // Events are consumed but not acted on in this helper
            }
            Err(_) => break,
        }
    }
}
