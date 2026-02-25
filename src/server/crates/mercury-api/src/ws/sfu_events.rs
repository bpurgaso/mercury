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

                    // Broadcast to all members of the server
                    if let Some(server_id) = server_id {
                        let member_ids =
                            mercury_db::servers::get_member_user_ids(&state.db, server_id)
                                .await
                                .unwrap_or_default();
                        state.ws_manager.send_to_users(&member_ids, &msg);
                    }
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

                    if let Some(server_id) = server_id {
                        let member_ids =
                            mercury_db::servers::get_member_user_ids(&state.db, server_id)
                                .await
                                .unwrap_or_default();
                        state.ws_manager.send_to_users(&member_ids, &msg);
                    }
                }
                SfuEvent::CallEnded {
                    room_id,
                    channel_id: _,
                    server_id,
                } => {
                    let payload = CallEndedEvent { room_id };
                    let msg = ServerMessage {
                        t: ServerEvent::CALL_ENDED,
                        d: serde_json::to_value(&payload).unwrap_or_default(),
                        seq: None,
                    };

                    if let Some(server_id) = server_id {
                        let member_ids =
                            mercury_db::servers::get_member_user_ids(&state.db, server_id)
                                .await
                                .unwrap_or_default();
                        state.ws_manager.send_to_users(&member_ids, &msg);
                    }
                }
                SfuEvent::ParticipantLeft {
                    user_id,
                    channel_id: _,
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

                    if let Some(server_id) = server_id {
                        let member_ids =
                            mercury_db::servers::get_member_user_ids(&state.db, server_id)
                                .await
                                .unwrap_or_default();
                        state.ws_manager.send_to_users(&member_ids, &msg);
                    }
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
