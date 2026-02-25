use mercury_core::ids::DmChannelId;
use mercury_media::SfuEvent;
use tokio::sync::mpsc;

use super::protocol::*;
use crate::state::AppState;

/// Spawn a background task that consumes SFU events and dispatches them
/// to the appropriate WebSocket clients.
pub fn spawn_sfu_event_consumer(state: AppState, mut event_rx: mpsc::Receiver<SfuEvent>) {
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            match event {
                SfuEvent::VoiceStateUpdate {
                    user_id,
                    channel_id,
                    self_mute,
                    self_deaf,
                    server_id,
                } => {
                    let payload = VoiceStateUpdateEvent {
                        user_id: user_id.to_string(),
                        channel_id: Some(channel_id.to_string()),
                        self_mute,
                        self_deaf,
                    };
                    let msg = ServerMessage {
                        t: ServerEvent::VOICE_STATE_UPDATE,
                        d: serde_json::to_value(&payload).unwrap_or_default(),
                        seq: None,
                    };

                    broadcast_to_channel_members(&state, server_id, channel_id, &msg).await;
                }
                SfuEvent::CallStarted {
                    room_id,
                    channel_id,
                    initiator_id,
                    server_id,
                } => {
                    let payload = CallStartedEvent {
                        room_id,
                        channel_id: channel_id.to_string(),
                        initiator_id: initiator_id.to_string(),
                    };
                    let msg = ServerMessage {
                        t: ServerEvent::CALL_STARTED,
                        d: serde_json::to_value(&payload).unwrap_or_default(),
                        seq: None,
                    };

                    broadcast_to_channel_members(&state, server_id, channel_id, &msg).await;
                }
                SfuEvent::CallEnded {
                    room_id,
                    channel_id,
                    server_id,
                } => {
                    let payload = CallEndedEvent { room_id };
                    let msg = ServerMessage {
                        t: ServerEvent::CALL_ENDED,
                        d: serde_json::to_value(&payload).unwrap_or_default(),
                        seq: None,
                    };

                    broadcast_to_channel_members(&state, server_id, channel_id, &msg).await;
                }
                SfuEvent::ParticipantLeft {
                    user_id,
                    channel_id,
                    server_id,
                } => {
                    // Broadcast VOICE_STATE_UPDATE with channel_id = null to indicate leave
                    let payload = VoiceStateUpdateEvent {
                        user_id: user_id.to_string(),
                        channel_id: None,
                        self_mute: false,
                        self_deaf: false,
                    };
                    let msg = ServerMessage {
                        t: ServerEvent::VOICE_STATE_UPDATE,
                        d: serde_json::to_value(&payload).unwrap_or_default(),
                        seq: None,
                    };

                    broadcast_to_channel_members(&state, server_id, channel_id, &msg).await;
                }
                SfuEvent::WebRtcSignal {
                    target_user,
                    from_user,
                    signal,
                } => {
                    let payload = WebrtcSignalEvent {
                        from_user: from_user.to_string(),
                        signal,
                    };
                    let msg = ServerMessage {
                        t: ServerEvent::WEBRTC_SIGNAL,
                        d: serde_json::to_value(&payload).unwrap_or_default(),
                        seq: None,
                    };
                    state.ws_manager.send_to_user(&target_user, &msg);
                }
            }
        }
    });
}

/// Broadcast a message to the appropriate members based on channel type.
/// For server channels (server_id is Some), broadcasts to all server members.
/// For DM channels (server_id is None), broadcasts to DM channel participants.
async fn broadcast_to_channel_members(
    state: &AppState,
    server_id: Option<mercury_core::ids::ServerId>,
    channel_id: mercury_core::ids::ChannelId,
    msg: &ServerMessage,
) {
    if let Some(server_id) = server_id {
        // Server channel — broadcast to all server members
        let member_ids = mercury_db::servers::get_member_user_ids(&state.db, server_id)
            .await
            .unwrap_or_default();
        state.ws_manager.send_to_users(&member_ids, msg);
    } else {
        // DM channel — broadcast to DM participants
        let dm_channel_id = DmChannelId(channel_id.0);
        let dm_members = mercury_db::dm_channels::get_dm_members(&state.db, dm_channel_id)
            .await
            .unwrap_or_default();
        let member_ids: Vec<_> = dm_members.iter().map(|m| m.user_id).collect();
        state.ws_manager.send_to_users(&member_ids, msg);
    }
}
