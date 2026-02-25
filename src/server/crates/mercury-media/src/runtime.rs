use std::net::SocketAddr;
use std::time::Duration;

use mercury_core::config::MediaConfig;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::room::RoomManager;
use crate::types::*;

/// Channel capacity for API <-> SFU communication.
const CHANNEL_CAPACITY: usize = 1024;

/// Interval for polling str0m Rtc instances for timeout-driven events.
const RTC_POLL_INTERVAL_MS: u64 = 50;

/// Handle used by the API runtime to communicate with the SFU runtime.
/// Cloneable and safe to store in AppState.
#[derive(Clone)]
pub struct SfuHandle {
    command_tx: mpsc::Sender<SfuCommand>,
}

impl SfuHandle {
    /// Send a command to join a room. Returns the JoinResult.
    pub async fn join_room(
        &self,
        user_id: mercury_core::ids::UserId,
        device_id: String,
        channel_id: mercury_core::ids::ChannelId,
        server_id: Option<mercury_core::ids::ServerId>,
    ) -> Result<JoinResult, SfuError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.command_tx
            .send(SfuCommand::JoinRoom {
                user_id,
                device_id,
                channel_id,
                server_id,
                reply: tx,
            })
            .await
            .map_err(|_| SfuError::Internal("SFU runtime unavailable".into()))?;
        rx.await
            .map_err(|_| SfuError::Internal("SFU reply dropped".into()))?
    }

    /// Leave a specific room.
    pub async fn leave_room(
        &self,
        user_id: mercury_core::ids::UserId,
        channel_id: mercury_core::ids::ChannelId,
    ) -> Result<(), SfuError> {
        self.command_tx
            .send(SfuCommand::LeaveRoom {
                user_id,
                channel_id,
            })
            .await
            .map_err(|_| SfuError::Internal("SFU runtime unavailable".into()))?;
        Ok(())
    }

    /// Leave all rooms (on disconnect).
    pub async fn leave_all(
        &self,
        user_id: mercury_core::ids::UserId,
    ) -> Result<(), SfuError> {
        self.command_tx
            .send(SfuCommand::LeaveAll { user_id })
            .await
            .map_err(|_| SfuError::Internal("SFU runtime unavailable".into()))?;
        Ok(())
    }

    /// Send a WebRTC signal. Returns an optional response signal (e.g., SDP answer).
    pub async fn webrtc_signal(
        &self,
        user_id: mercury_core::ids::UserId,
        room_id: String,
        signal: WebRtcSignalData,
    ) -> Result<Option<WebRtcSignalData>, SfuError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.command_tx
            .send(SfuCommand::WebRtcSignal {
                user_id,
                room_id,
                signal,
                reply: tx,
            })
            .await
            .map_err(|_| SfuError::Internal("SFU runtime unavailable".into()))?;
        rx.await
            .map_err(|_| SfuError::Internal("SFU reply dropped".into()))?
    }

    /// Update voice state (mute/deaf).
    pub async fn update_voice_state(
        &self,
        user_id: mercury_core::ids::UserId,
        channel_id: mercury_core::ids::ChannelId,
        self_mute: bool,
        self_deaf: bool,
    ) -> Result<(), SfuError> {
        self.command_tx
            .send(SfuCommand::UpdateVoiceState {
                user_id,
                channel_id,
                self_mute,
                self_deaf,
            })
            .await
            .map_err(|_| SfuError::Internal("SFU runtime unavailable".into()))?;
        Ok(())
    }

    /// Get room info by room ID.
    pub async fn get_room(&self, room_id: String) -> Option<RoomInfo> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.command_tx
            .send(SfuCommand::GetRoom {
                room_id,
                reply: tx,
            })
            .await
            .ok()?;
        rx.await.ok()?
    }

    /// Get room info by channel ID.
    pub async fn get_room_by_channel(
        &self,
        channel_id: mercury_core::ids::ChannelId,
    ) -> Option<RoomInfo> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.command_tx
            .send(SfuCommand::GetRoomByChannel {
                channel_id,
                reply: tx,
            })
            .await
            .ok()?;
        rx.await.ok()?
    }
}

/// Start the SFU runtime on a dedicated Tokio runtime with core affinity.
///
/// Returns an `SfuHandle` for the API to send commands, and an `mpsc::Receiver`
/// for the API to consume SFU events (voice state updates, call events, etc.).
pub fn start_sfu(config: &MediaConfig) -> (SfuHandle, mpsc::Receiver<SfuEvent>) {
    let (command_tx, command_rx) = mpsc::channel::<SfuCommand>(CHANNEL_CAPACITY);
    let (event_tx, event_rx) = mpsc::channel::<SfuEvent>(CHANNEL_CAPACITY);

    let max_participants = config.max_participants_per_room;
    let empty_room_timeout = Duration::from_secs(config.empty_room_timeout_secs);
    let dedicated_cores = config.dedicated_cores;
    let udp_port_start = config.udp_port_range_start;

    // Build a dedicated Tokio runtime for the SFU
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(dedicated_cores.max(1))
        .thread_name("sfu-worker")
        .on_thread_start(move || {
            pin_to_dedicated_cores(dedicated_cores);
        })
        .enable_all()
        .build()
        .expect("failed to build SFU tokio runtime");

    // Spawn the combined command + network loop on the dedicated runtime
    rt.spawn(sfu_main_loop(
        command_rx,
        event_tx,
        max_participants,
        empty_room_timeout,
        udp_port_start,
    ));

    // Leak the runtime so it lives for the process lifetime.
    // This is intentional — the SFU runtime runs until process exit.
    std::mem::forget(rt);

    info!(
        cores = dedicated_cores,
        max_participants, "SFU runtime started"
    );

    (SfuHandle { command_tx }, event_rx)
}

/// Pin the current thread to the last N CPU cores.
fn pin_to_dedicated_cores(n: usize) {
    let core_ids = core_affinity::get_core_ids().unwrap_or_default();
    if core_ids.is_empty() || n == 0 {
        return;
    }
    // Take the last N cores
    let start = core_ids.len().saturating_sub(n);
    let dedicated: Vec<_> = core_ids[start..].to_vec();

    // Pick a core for this thread (round-robin by thread ID)
    let thread_id = std::thread::current().id();
    let hash = format!("{:?}", thread_id);
    let idx = hash
        .bytes()
        .fold(0usize, |acc, b| acc.wrapping_add(b as usize))
        % dedicated.len();

    if !core_affinity::set_for_current(dedicated[idx]) {
        warn!("failed to set core affinity for SFU worker thread");
    }
}

/// Combined command processing + network I/O + str0m polling loop.
async fn sfu_main_loop(
    mut command_rx: mpsc::Receiver<SfuCommand>,
    event_tx: mpsc::Sender<SfuEvent>,
    max_participants: usize,
    empty_room_timeout: Duration,
    udp_port_start: u16,
) {
    // Bind the SFU UDP socket
    let bind_addr: SocketAddr = format!("0.0.0.0:{udp_port_start}").parse().unwrap();
    let socket = match UdpSocket::bind(bind_addr).await {
        Ok(s) => {
            info!("SFU UDP socket bound to {}", s.local_addr().unwrap());
            s
        }
        Err(e) => {
            // Fall back to any available port if the configured port is busy
            warn!("failed to bind SFU UDP to {bind_addr}: {e}, trying any port");
            UdpSocket::bind("0.0.0.0:0")
                .await
                .expect("failed to bind SFU UDP socket on any port")
        }
    };

    let local_addr = socket.local_addr().unwrap();
    let mut room_manager =
        RoomManager::new(max_participants, empty_room_timeout, event_tx, local_addr);

    let mut buf = vec![0u8; 2000];
    let mut poll_interval = tokio::time::interval(Duration::from_millis(RTC_POLL_INTERVAL_MS));
    poll_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            // Process API commands
            cmd = command_rx.recv() => {
                let Some(cmd) = cmd else { break };
                handle_command(cmd, &mut room_manager, &socket).await;
            }

            // Receive UDP packets for str0m
            result = socket.recv_from(&mut buf) => {
                match result {
                    Ok((n, addr)) => {
                        room_manager.route_udp_packet(&buf[..n], addr, local_addr, &socket);
                    }
                    Err(e) => {
                        warn!("SFU UDP recv error: {e}");
                    }
                }
            }

            // Periodic polling of str0m Rtc instances
            _ = poll_interval.tick() => {
                room_manager.poll_timeouts(&socket);
            }
        }
    }
}

/// Handle a single SFU command.
async fn handle_command(
    cmd: SfuCommand,
    room_manager: &mut RoomManager,
    socket: &UdpSocket,
) {
    match cmd {
        SfuCommand::JoinRoom {
            user_id,
            device_id,
            channel_id,
            server_id,
            reply,
        } => {
            let result = room_manager
                .join(user_id, device_id, channel_id, server_id)
                .await;
            let _ = reply.send(result);
        }
        SfuCommand::LeaveRoom {
            user_id,
            channel_id,
        } => {
            room_manager.leave(user_id, channel_id).await;
        }
        SfuCommand::LeaveAll { user_id } => {
            room_manager.leave_all(user_id).await;
        }
        SfuCommand::WebRtcSignal {
            user_id,
            room_id,
            signal,
            reply,
        } => {
            let result = room_manager
                .handle_signal(user_id, &room_id, signal, socket)
                .await;
            let _ = reply.send(result);
        }
        SfuCommand::UpdateVoiceState {
            user_id,
            channel_id,
            self_mute,
            self_deaf,
        } => {
            room_manager
                .update_voice_state(user_id, channel_id, self_mute, self_deaf)
                .await;
        }
        SfuCommand::GetRoom { room_id, reply } => {
            let _ = reply.send(room_manager.get_room(&room_id));
        }
        SfuCommand::GetRoomByChannel { channel_id, reply } => {
            let _ = reply.send(room_manager.get_room_by_channel(channel_id));
        }
    }
}
