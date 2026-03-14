use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use chrono::Utc;
use mercury_core::ids::{ChannelId, ServerId, UserId};
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::media::{Direction, KeyframeRequest, MediaData, MediaKind, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event as RtcEvent, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::{detect_local_ip, types::*};

/// Metric name constant — must match `mercury-api`'s `metrics.rs`.
const MEDIA_BANDWIDTH_BYTES: &str = "mercury_media_bandwidth_bytes";

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
    /// Incoming tracks — media this peer's client is sending to us.
    tracks_in: Vec<TrackIn>,
    /// Outgoing tracks — media we forward from other peers to this client.
    tracks_out: Vec<TrackOut>,
    /// Pending SDP offer awaiting an answer from this client.
    pending_offer: Option<SdpPendingOffer>,
}

/// Incoming track from a remote peer (client sending media to SFU).
struct TrackIn {
    origin: UserId,
    mid: Mid,
    kind: MediaKind,
}

/// Outgoing track to a remote peer (SFU forwarding another user's media to client).
struct TrackOut {
    source_user: UserId,
    source_mid: Mid,
    kind: MediaKind,
    state: TrackOutState,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TrackOutState {
    /// Needs SDP renegotiation to open.
    ToOpen,
    /// Offer sent, awaiting answer. Mid is the local media id assigned by add_media().
    Negotiating(Mid),
    /// Ready for forwarding.
    Open(Mid),
}

impl TrackOut {
    fn mid(&self) -> Option<Mid> {
        match self.state {
            TrackOutState::ToOpen => None,
            TrackOutState::Negotiating(m) | TrackOutState::Open(m) => Some(m),
        }
    }
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
    /// Uses sample mode (default) — emits MediaData events instead of raw RTP.
    fn create_rtc(&self) -> Rtc {
        let mut rtc = Rtc::builder().build(Instant::now());

        // Add our SFU's UDP socket as a local ICE candidate.
        // str0m rejects 0.0.0.0 as invalid, so we detect the machine's
        // actual network IP. Using 127.0.0.1 breaks ICE when the client's
        // WebRTC stack picks the LAN address (Chromium filters out loopback
        // candidates), causing a source-address mismatch on STUN responses.
        let candidate_addr = if self.local_addr.ip().is_unspecified() {
            let ip = detect_local_ip().unwrap_or(std::net::IpAddr::V4(
                std::net::Ipv4Addr::LOCALHOST,
            ));
            SocketAddr::new(ip, self.local_addr.port())
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

        // Collect existing peers' incoming tracks so the new peer can receive them.
        // Must be done before adding the new participant to avoid including self.
        let existing_tracks: Vec<(UserId, Mid, MediaKind)> = room
            .participants
            .keys()
            .flat_map(|&uid| {
                self.peer_sessions
                    .get(&uid)
                    .map(|p| {
                        p.tracks_in
                            .iter()
                            .map(|t| (t.origin, t.mid, t.kind))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            })
            .collect();

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

        // Create str0m peer session with TrackOuts for existing peers' tracks
        let rtc = self.create_rtc();
        let tracks_out = existing_tracks
            .into_iter()
            .map(|(origin, mid, kind)| TrackOut {
                source_user: origin,
                source_mid: mid,
                kind,
                state: TrackOutState::ToOpen,
            })
            .collect();

        let peer = PeerSession {
            rtc,
            user_id,
            room_id: room_id.clone(),
            connected: false,
            remote_addr: None,
            sdp_initialized: false,
            tracks_in: Vec::new(),
            tracks_out,
            pending_offer: None,
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

        // Remove TrackOut entries referencing the leaving user from all other peers
        if let Some(room) = self.rooms_by_id.get(&room_id) {
            let other_users: Vec<UserId> = room
                .participants
                .keys()
                .copied()
                .filter(|&uid| uid != user_id)
                .collect();
            for other_uid in other_users {
                if let Some(other_peer) = self.peer_sessions.get_mut(&other_uid) {
                    other_peer
                        .tracks_out
                        .retain(|t| t.source_user != user_id);
                }
            }
        }

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

                let handle = tokio::spawn(async move {
                    tokio::time::sleep(timeout).await;
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
    /// Handles SDP offers (from client), SDP answers (from SFU-initiated renegotiation),
    /// and ICE candidates.
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

                // Scope the mutable borrow of the peer session
                let answer_sdp = {
                    let peer = self
                        .peer_sessions
                        .get_mut(&user_id)
                        .ok_or_else(|| SfuError::Internal("peer session not found".into()))?;

                    // Accept the offer and generate an answer
                    let answer = peer
                        .rtc
                        .sdp_api()
                        .accept_offer(offer)
                        .map_err(|e| {
                            SfuError::Internal(format!("str0m accept_offer failed: {e}"))
                        })?;

                    // If the client sent a new offer, any pending SFU-initiated offer
                    // is invalidated (glare resolution). Reset negotiating tracks.
                    peer.pending_offer = None;
                    for track in &mut peer.tracks_out {
                        if let TrackOutState::Negotiating(_) = track.state {
                            track.state = TrackOutState::ToOpen;
                        }
                    }

                    // Mark DTLS as initialized — safe to call poll_output now
                    peer.sdp_initialized = true;

                    answer.to_sdp_string()
                }; // peer borrow ends here

                // Drain outputs (sends DTLS packets), process events, negotiate
                self.drain_and_forward(user_id, socket);

                Ok(Some(WebRtcSignalData {
                    signal_type: "answer".to_string(),
                    sdp: Some(answer_sdp),
                    candidate: None,
                }))
            }

            "answer" => {
                let sdp_str = signal
                    .sdp
                    .as_deref()
                    .ok_or_else(|| SfuError::Internal("answer missing sdp".into()))?;

                let answer = SdpAnswer::from_sdp_string(sdp_str)
                    .map_err(|e| SfuError::Internal(format!("invalid SDP answer: {e}")))?;

                {
                    let peer = self
                        .peer_sessions
                        .get_mut(&user_id)
                        .ok_or_else(|| SfuError::Internal("peer session not found".into()))?;

                    let pending = peer
                        .pending_offer
                        .take()
                        .ok_or_else(|| SfuError::Internal("no pending offer for answer".into()))?;

                    peer.rtc
                        .sdp_api()
                        .accept_answer(pending, answer)
                        .map_err(|e| {
                            SfuError::Internal(format!("str0m accept_answer failed: {e}"))
                        })?;

                    // Move negotiating tracks to open
                    for track in &mut peer.tracks_out {
                        if let TrackOutState::Negotiating(m) = track.state {
                            track.state = TrackOutState::Open(m);
                        }
                    }
                }

                // Drain outputs after accepting the answer
                self.drain_and_forward(user_id, socket);

                Ok(None)
            }

            "ice_candidate" => {
                if let Some(candidate_str) = &signal.candidate {
                    // The client sends JSON.stringify(event.candidate.toJSON()),
                    // which wraps the SDP candidate string inside a JSON object.
                    // Extract the "candidate" field if it's JSON, otherwise use as-is.
                    let sdp_str = if candidate_str.starts_with('{') {
                        serde_json::from_str::<serde_json::Value>(candidate_str)
                            .ok()
                            .and_then(|v| {
                                v.get("candidate")
                                    .and_then(|c| c.as_str())
                                    .map(String::from)
                            })
                    } else {
                        Some(candidate_str.clone())
                    };

                    if let Some(sdp) = sdp_str {
                        match Candidate::from_sdp_string(&sdp) {
                            Ok(candidate) => {
                                let sdp_init = if let Some(peer) =
                                    self.peer_sessions.get_mut(&user_id)
                                {
                                    peer.rtc.add_remote_candidate(candidate);
                                    peer.sdp_initialized
                                } else {
                                    false
                                };
                                if sdp_init {
                                    self.drain_and_forward(user_id, socket);
                                }
                            }
                            Err(e) => {
                                debug!("failed to parse ICE candidate: {e}");
                            }
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

    /// Drain outputs from an Rtc instance, forward media to other room members,
    /// and trigger SDP renegotiation for any peers with pending outgoing tracks.
    fn drain_and_forward(&mut self, user_id: UserId, socket: &UdpSocket) {
        let room_id = match self.user_rooms.get(&user_id) {
            Some(rid) => rid.clone(),
            None => return,
        };

        // ── Phase 1: Drain events from this peer ─────────────────
        let mut media_items: Vec<MediaData> = Vec::new();
        let mut new_tracks: Vec<(Mid, MediaKind)> = Vec::new();
        let mut keyframe_requests: Vec<KeyframeRequest> = Vec::new();
        let mut disconnected = false;

        if let Some(peer) = self.peer_sessions.get_mut(&user_id) {
            if !peer.sdp_initialized {
                return;
            }
            let _ = peer.rtc.handle_input(Input::Timeout(Instant::now()));
            loop {
                match peer.rtc.poll_output() {
                    Ok(Output::Timeout(_)) => break,
                    Ok(Output::Transmit(t)) => {
                        metrics::gauge!(MEDIA_BANDWIDTH_BYTES, "direction" => "download")
                            .increment(t.contents.len() as f64);
                        let _ = socket.try_send_to(&t.contents, t.destination);
                    }
                    Ok(Output::Event(event)) => match event {
                        RtcEvent::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                            debug!("peer {user_id} ICE disconnected");
                            disconnected = true;
                        }
                        RtcEvent::MediaData(data) => {
                            metrics::gauge!(MEDIA_BANDWIDTH_BYTES, "direction" => "upload")
                                .increment(data.data.len() as f64);
                            media_items.push(data);
                        }
                        RtcEvent::MediaAdded(media) => {
                            debug!(
                                "media added for peer {user_id}: mid={}, kind={:?}, dir={:?}",
                                media.mid, media.kind, media.direction
                            );
                            peer.connected = true;
                            // Only register tracks where the SFU receives media from the client
                            match media.direction {
                                Direction::RecvOnly | Direction::SendRecv => {
                                    new_tracks.push((media.mid, media.kind));
                                }
                                _ => {}
                            }
                        }
                        RtcEvent::KeyframeRequest(req) => {
                            keyframe_requests.push(req);
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

        // ── Phase 2: Register new incoming tracks ────────────────
        if !new_tracks.is_empty() {
            // Add TrackIn entries to the source peer
            if let Some(peer) = self.peer_sessions.get_mut(&user_id) {
                for &(mid, kind) in &new_tracks {
                    peer.tracks_in.push(TrackIn {
                        origin: user_id,
                        mid,
                        kind,
                    });
                }
            }

            // Add TrackOut entries to all other peers in the room
            if let Some(room) = self.rooms_by_id.get(&room_id) {
                let other_users: Vec<UserId> = room
                    .participants
                    .keys()
                    .copied()
                    .filter(|&uid| uid != user_id)
                    .collect();

                for other_uid in other_users {
                    if let Some(other_peer) = self.peer_sessions.get_mut(&other_uid) {
                        for &(mid, kind) in &new_tracks {
                            other_peer.tracks_out.push(TrackOut {
                                source_user: user_id,
                                source_mid: mid,
                                kind,
                                state: TrackOutState::ToOpen,
                            });
                        }
                    }
                }
            }
        }

        // ── Phase 3: Forward media data to other peers ───────────
        if !media_items.is_empty() {
            if let Some(room) = self.rooms_by_id.get(&room_id) {
                let other_users: Vec<UserId> = room
                    .participants
                    .keys()
                    .copied()
                    .filter(|&uid| uid != user_id)
                    .collect();

                for data in &media_items {
                    for &other_uid in &other_users {
                        if let Some(other_peer) = self.peer_sessions.get_mut(&other_uid) {
                            // Find matching Open TrackOut for this source track
                            let out_mid = other_peer
                                .tracks_out
                                .iter()
                                .find(|t| {
                                    t.source_user == user_id
                                        && t.source_mid == data.mid
                                        && matches!(t.state, TrackOutState::Open(_))
                                })
                                .and_then(|t| match t.state {
                                    TrackOutState::Open(m) => Some(m),
                                    _ => None,
                                });

                            if let Some(mid) = out_mid {
                                if let Some(writer) = other_peer.rtc.writer(mid) {
                                    if let Some(pt) = writer.match_params(data.params) {
                                        if let Err(e) = writer.write(
                                            pt,
                                            data.network_time,
                                            data.time,
                                            data.data.clone(),
                                        ) {
                                            warn!(
                                                "failed to forward media to {other_uid}: {e}"
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // ── Phase 4: Route keyframe requests to source peers ─────
        for req in keyframe_requests {
            // Find which source track this outgoing track corresponds to
            let source_info = self
                .peer_sessions
                .get(&user_id)
                .and_then(|peer| {
                    peer.tracks_out
                        .iter()
                        .find(|t| t.mid() == Some(req.mid))
                        .map(|t| (t.source_user, t.source_mid))
                });

            if let Some((source_user, source_mid)) = source_info {
                if let Some(source_peer) = self.peer_sessions.get_mut(&source_user) {
                    if let Some(mut writer) = source_peer.rtc.writer(source_mid) {
                        let _ = writer.request_keyframe(req.rid, req.kind);
                    }
                }
            }
        }

        // ── Phase 5: Negotiate for peers with ToOpen tracks ──────
        self.negotiate_tracks_in_room(&room_id, socket);

        // Handle disconnect
        let _ = disconnected;
    }

    /// For each peer in the room that has un-negotiated outgoing tracks (ToOpen),
    /// create an SDP offer and send it to the client via WebSocket.
    fn negotiate_tracks_in_room(&mut self, room_id: &str, socket: &UdpSocket) {
        let room = match self.rooms_by_id.get(room_id) {
            Some(r) => r,
            None => return,
        };

        let peer_ids: Vec<UserId> = room.participants.keys().copied().collect();
        let event_tx = self.event_tx.clone();

        for uid in peer_ids {
            let peer = match self.peer_sessions.get_mut(&uid) {
                Some(p) => p,
                None => continue,
            };

            // Skip peers not yet initialized or with a pending offer already in flight
            if !peer.sdp_initialized || peer.pending_offer.is_some() {
                continue;
            }

            let has_to_open = peer
                .tracks_out
                .iter()
                .any(|t| matches!(t.state, TrackOutState::ToOpen));
            if !has_to_open {
                continue;
            }

            // Build the SDP change: add a SendOnly media line for each ToOpen track
            let mut change = peer.rtc.sdp_api();

            for track in &mut peer.tracks_out {
                if matches!(track.state, TrackOutState::ToOpen) {
                    let mid =
                        change.add_media(track.kind, Direction::SendOnly, None, None, None);
                    track.state = TrackOutState::Negotiating(mid);
                }
            }

            if !change.has_changes() {
                continue;
            }

            let Some((offer, pending)) = change.apply() else {
                continue;
            };

            peer.pending_offer = Some(pending);
            let offer_sdp = offer.to_sdp_string();

            debug!("sending SFU-initiated offer to peer {uid}");

            let _ = event_tx.try_send(SfuEvent::WebRtcSignal {
                target_user: uid,
                from_user: uid,
                signal: WebRtcSignalData {
                    signal_type: "offer".to_string(),
                    sdp: Some(offer_sdp),
                    candidate: None,
                },
            });

            // Drain any transmit outputs generated by the SDP change
            let _ = peer.rtc.handle_input(Input::Timeout(Instant::now()));
            loop {
                match peer.rtc.poll_output() {
                    Ok(Output::Timeout(_)) => break,
                    Ok(Output::Transmit(t)) => {
                        let _ = socket.try_send_to(&t.contents, t.destination);
                    }
                    Ok(Output::Event(_)) => {}
                    Err(_) => break,
                }
            }
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
