use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use fred::prelude::*;
use futures_util::{SinkExt, StreamExt};
use mercury_auth::jwt;
use mercury_core::ids::{ChannelId, DeviceId, DmChannelId, MessageId, UserId};
use mercury_db::{channels, servers, users};
use tokio::sync::mpsc;
use tokio::time::{self, Duration, Instant};

use crate::state::AppState;

use super::manager::{BufferedEvent, ConnectionHandle, SessionState};
use super::presence;
use super::protocol::*;

/// Timeout for the client to send an identify or resume message after connecting.
const IDENTIFY_TIMEOUT_SECS: u64 = 10;

/// Maximum duration for a session to be resumable after disconnect (5 minutes).
const SESSION_RESUME_WINDOW_SECS: u64 = 300;

/// Handle a WebSocket connection after successful upgrade.
///
/// The `pre_auth_claims` contain the validated JWT claims from the query parameter.
/// The connection waits for either an `identify` or `resume` message, then enters
/// the main event loop.
pub async fn handle_connection(
    state: AppState,
    socket: WebSocket,
    pre_auth_claims: jwt::Claims,
) {
    tracing::debug!("handle_connection: entered, sub={}", pre_auth_claims.sub);
    let (mut ws_sink, mut ws_stream) = socket.split();

    // Wait for identify or resume within timeout
    let first_msg = time::timeout(Duration::from_secs(IDENTIFY_TIMEOUT_SECS), async {
        while let Some(msg) = ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    return Some(text.to_string());
                }
                Ok(Message::Close(_)) => return None,
                Err(_) => return None,
                _ => continue, // skip ping/pong/binary
            }
        }
        None
    })
    .await;

    let first_text = match first_msg {
        Ok(Some(text)) => {
            tracing::debug!("handle_connection: received first message, len={}", text.len());
            text
        }
        Ok(None) => {
            tracing::debug!("handle_connection: connection closed before identify");
            let _ = ws_sink
                .send(Message::Close(Some(CloseFrame {
                    code: close_codes::SESSION_EXPIRED,
                    reason: "identify timeout".into(),
                })))
                .await;
            return;
        }
        _ => {
            tracing::debug!("handle_connection: identify timeout");
            // Timeout or connection closed before identify
            let _ = ws_sink
                .send(Message::Close(Some(CloseFrame {
                    code: close_codes::SESSION_EXPIRED,
                    reason: "identify timeout".into(),
                })))
                .await;
            return;
        }
    };

    let client_msg: ClientMessage = match serde_json::from_str(&first_text) {
        Ok(m) => m,
        Err(_) => {
            let _ = ws_sink
                .send(Message::Close(Some(CloseFrame {
                    code: close_codes::INVALID_TOKEN,
                    reason: "invalid message format".into(),
                })))
                .await;
            return;
        }
    };

    tracing::debug!("handle_connection: parsed op={:?}", client_msg.op);

    match client_msg.op {
        ClientOp::Identify => {
            let payload: IdentifyPayload = match serde_json::from_value(client_msg.d) {
                Ok(p) => p,
                Err(_) => {
                    let _ = ws_sink
                        .send(Message::Close(Some(CloseFrame {
                            code: close_codes::INVALID_TOKEN,
                            reason: "invalid identify payload".into(),
                        })))
                        .await;
                    return;
                }
            };

            handle_identify(state, ws_sink, ws_stream, pre_auth_claims, payload).await;
        }
        ClientOp::Resume => {
            let payload: ResumePayload = match serde_json::from_value(client_msg.d) {
                Ok(p) => p,
                Err(_) => {
                    let _ = ws_sink
                        .send(Message::Close(Some(CloseFrame {
                            code: close_codes::SESSION_EXPIRED,
                            reason: "invalid resume payload".into(),
                        })))
                        .await;
                    return;
                }
            };

            handle_resume(state, ws_sink, ws_stream, pre_auth_claims, payload).await;
        }
        _ => {
            let _ = ws_sink
                .send(Message::Close(Some(CloseFrame {
                    code: close_codes::INVALID_TOKEN,
                    reason: "expected identify or resume".into(),
                })))
                .await;
        }
    }
}

/// Handle the identify flow: validate token, create session, send READY, start event loop.
async fn handle_identify(
    state: AppState,
    mut ws_sink: futures_util::stream::SplitSink<WebSocket, Message>,
    ws_stream: futures_util::stream::SplitStream<WebSocket>,
    claims: jwt::Claims,
    payload: IdentifyPayload,
) {
    tracing::debug!("handle_identify: entered, device_id={}", payload.device_id);

    let user_id = match jwt::user_id_from_claims(&claims) {
        Ok(id) => {
            tracing::debug!("handle_identify: user_id={id}");
            id
        }
        Err(e) => {
            tracing::debug!("handle_identify: invalid user ID: {e}");
            let _ = ws_sink
                .send(Message::Close(Some(CloseFrame {
                    code: close_codes::INVALID_TOKEN,
                    reason: "invalid user ID".into(),
                })))
                .await;
            return;
        }
    };

    // Fetch user from database for READY payload
    let user = match users::get_user_by_id(&state.db, user_id).await {
        Ok(Some(u)) => u,
        _ => {
            let _ = ws_sink
                .send(Message::Close(Some(CloseFrame {
                    code: close_codes::INVALID_TOKEN,
                    reason: "user not found".into(),
                })))
                .await;
            return;
        }
    };

    // Update session in Redis with device info (reuse existing session:{jti} key)
    let session_data = mercury_auth::session::SessionData {
        user_id: user_id.0.to_string(),
        device_id: Some(payload.device_id.clone()),
        expires_at: claims.exp,
        paired_refresh_jti: None,
    };
    let session_json = serde_json::to_string(&session_data).unwrap_or_default();
    let session_key = format!("session:{}", claims.jti);
    // Preserve existing TTL
    let ttl: i64 = state.redis.ttl::<i64, _>(&session_key).await.unwrap_or(3600);
    let ttl = if ttl > 0 { ttl } else { 3600 };
    if let Err(e) = state
        .redis
        .set::<(), _, _>(
            &session_key,
            session_json.as_str(),
            Some(Expiration::EX(ttl)),
            None,
            false,
        )
        .await
    {
        tracing::error!("failed to update session in Redis: {e}");
    }

    // Create a unique session ID for this WebSocket connection
    let session_id = uuid::Uuid::now_v7().to_string();

    // Create session state in the connection manager
    let session_state = state.ws_manager.create_session(
        session_id.clone(),
        user_id,
        payload.device_id.clone(),
        claims.jti.clone(),
    );

    // Create channel for outgoing messages
    let (tx, rx) = mpsc::unbounded_channel();

    // Register connection
    state.ws_manager.add_connection(ConnectionHandle {
        session_id: session_id.clone(),
        device_id: payload.device_id.clone(),
        user_id,
        tx,
    });

    // Set presence to online
    if let Err(e) =
        presence::set_online(&state.redis, &state.ws_manager, user_id, &payload.device_id).await
    {
        tracing::warn!("failed to set presence online: {e}");
    }

    // Cache the user's block list in Redis for fast enforcement
    if let Err(e) =
        mercury_moderation::blocks::cache_block_list(&state.db, &state.redis, user_id).await
    {
        tracing::warn!("failed to cache block list: {e}");
    }

    tracing::debug!("handle_identify: session created, sending READY");

    // Query user's actual servers and channels for READY payload
    let user_servers = mercury_db::servers::list_servers_for_user(&state.db, user_id)
        .await
        .unwrap_or_default();
    let user_channels = channels::list_channels_for_user(&state.db, user_id)
        .await
        .unwrap_or_default();

    // Query user's DM channels for READY payload
    let user_dm_channels = mercury_db::dm_channels::list_dm_channels_for_user(&state.db, user_id)
        .await
        .unwrap_or_default();

    let servers_json: Vec<serde_json::Value> = user_servers
        .iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id.to_string(),
                "name": s.name,
                "owner_id": s.owner_id.to_string(),
                "invite_code": s.invite_code,
            })
        })
        .collect();

    let channels_json: Vec<serde_json::Value> = user_channels
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id.to_string(),
                "server_id": c.server_id.to_string(),
                "name": c.name,
                "channel_type": c.channel_type,
                "encryption_mode": c.encryption_mode,
                "position": c.position,
                "topic": c.topic,
                "created_at": c.created_at.map(|t| t.to_rfc3339()),
            })
        })
        .collect();

    let dm_channels_json: Vec<serde_json::Value> = user_dm_channels
        .iter()
        .map(|dm| {
            serde_json::json!({
                "id": dm.id.to_string(),
                "recipient": {
                    "id": dm.recipient_id.to_string(),
                    "username": dm.recipient_username,
                    "display_name": dm.recipient_display_name,
                    "avatar_url": dm.recipient_avatar_url,
                },
                "created_at": dm.created_at.map(|t| t.to_rfc3339()),
            })
        })
        .collect();

    // Build and send READY payload
    let ready = ReadyPayload {
        user: ReadyUser {
            id: user.id.0.to_string(),
            username: user.username,
            display_name: user.display_name,
            email: user.email,
            avatar_url: user.avatar_url,
            status: user.status,
        },
        servers: servers_json,
        dm_channels: dm_channels_json,
        session_id: session_id.clone(),
        heartbeat_interval: state.heartbeat_interval_secs,
        channels: channels_json,
    };

    let ready_msg = ServerMessage {
        t: ServerEvent::READY,
        d: serde_json::to_value(ready).unwrap_or_default(),
        seq: None,
    };

    let ready_json = serde_json::to_string(&ready_msg).unwrap_or_default();
    if ws_sink
        .send(Message::Text(ready_json.into()))
        .await
        .is_err()
    {
        cleanup_connection(&state, &session_id, user_id, &payload.device_id).await;
        return;
    }

    tracing::debug!("handle_identify: READY sent, entering event loop");

    // Enter main event loop
    run_event_loop(
        state,
        ws_sink,
        ws_stream,
        rx,
        session_state,
        session_id,
        user_id,
        payload.device_id,
    )
    .await;
}

/// Handle the resume flow: validate session, replay missed events, start event loop.
async fn handle_resume(
    state: AppState,
    mut ws_sink: futures_util::stream::SplitSink<WebSocket, Message>,
    ws_stream: futures_util::stream::SplitStream<WebSocket>,
    claims: jwt::Claims,
    payload: ResumePayload,
) {
    let user_id = match jwt::user_id_from_claims(&claims) {
        Ok(id) => id,
        Err(_) => {
            let _ = ws_sink
                .send(Message::Close(Some(CloseFrame {
                    code: close_codes::SESSION_EXPIRED,
                    reason: "invalid user ID".into(),
                })))
                .await;
            return;
        }
    };

    // Look up existing session state
    let session_state = match state.ws_manager.get_session(&payload.session_id) {
        Some(s) if s.user_id == user_id => s,
        _ => {
            // Session not found or user mismatch — force fresh identify
            let _ = ws_sink
                .send(Message::Close(Some(CloseFrame {
                    code: close_codes::SESSION_EXPIRED,
                    reason: "session expired or invalid".into(),
                })))
                .await;
            return;
        }
    };

    // Replay missed events
    let missed_events = session_state.events_since(payload.seq);
    let replayed_count = missed_events.len() as u64;

    for event in &missed_events {
        let send_result = match event {
            BufferedEvent::Text(json) => ws_sink.send(Message::Text(json.clone().into())).await,
            BufferedEvent::Binary(bytes) => {
                ws_sink.send(Message::Binary(bytes.clone().into())).await
            }
        };
        if send_result.is_err() {
            return;
        }
    }

    // Send RESUMED
    let resumed_msg = ServerMessage {
        t: ServerEvent::RESUMED,
        d: serde_json::to_value(ResumedPayload {
            replayed_events: replayed_count,
        })
        .unwrap_or_default(),
        seq: None,
    };

    let resumed_json = serde_json::to_string(&resumed_msg).unwrap_or_default();
    if ws_sink
        .send(Message::Text(resumed_json.into()))
        .await
        .is_err()
    {
        return;
    }

    let device_id = session_state.device_id.clone();
    let session_id = payload.session_id.clone();

    // Re-register connection with new sender channel
    let (tx, rx) = mpsc::unbounded_channel();
    state.ws_manager.add_connection(ConnectionHandle {
        session_id: session_id.clone(),
        device_id: device_id.clone(),
        user_id,
        tx,
    });

    // Cancel pending offline debounce
    if let Err(e) =
        presence::set_online(&state.redis, &state.ws_manager, user_id, &device_id).await
    {
        tracing::warn!("failed to restore presence on resume: {e}");
    }

    // Enter main event loop
    run_event_loop(
        state,
        ws_sink,
        ws_stream,
        rx,
        session_state,
        session_id,
        user_id,
        device_id,
    )
    .await;
}

/// Main event loop: handles incoming client messages and outgoing server events.
/// Monitors heartbeat and disconnects clients that miss 3 consecutive heartbeats.
#[allow(clippy::too_many_arguments)]
async fn run_event_loop(
    state: AppState,
    mut ws_sink: futures_util::stream::SplitSink<WebSocket, Message>,
    mut ws_stream: futures_util::stream::SplitStream<WebSocket>,
    mut rx: mpsc::UnboundedReceiver<EncodedServerMessage>,
    session_state: Arc<SessionState>,
    session_id: String,
    user_id: UserId,
    device_id: String,
) {
    tracing::debug!("run_event_loop: entered for user={user_id} session={session_id}");

    let heartbeat_interval = Duration::from_secs(state.heartbeat_interval_secs);
    let heartbeat_timeout = heartbeat_interval * HEARTBEAT_MISS_LIMIT;
    let mut last_heartbeat = Instant::now();
    let mut heartbeat_check = time::interval(heartbeat_interval);
    // Skip the first tick which fires immediately
    heartbeat_check.tick().await;

    loop {
        tokio::select! {
            // Outgoing: server events to send to this client
            Some(event) = rx.recv() => {
                let seq = session_state.next_seq();

                match event {
                    EncodedServerMessage::Text(mut msg) => {
                        msg.seq = Some(seq);
                        let json = match serde_json::to_string(&msg) {
                            Ok(j) => j,
                            Err(_) => continue,
                        };
                        session_state.buffer_event(seq, BufferedEvent::Text(json.clone()));
                        if ws_sink.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    EncodedServerMessage::Binary(bytes) => {
                        // For binary frames, inject seq into the bytes.
                        // The bytes are a MessagePack map — we re-encode with seq added.
                        let bytes_with_seq = inject_seq_into_msgpack(&bytes, seq);
                        session_state.buffer_event(seq, BufferedEvent::Binary(bytes_with_seq.clone()));
                        if ws_sink.send(Message::Binary(bytes_with_seq.into())).await.is_err() {
                            break;
                        }
                    }
                }
            }

            // Incoming: client messages
            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let text_str = text.to_string();

                        // Enforce size limit on text frames (same as binary frames)
                        if text_str.len() > MAX_MESSAGE_PAYLOAD_SIZE {
                            send_error_json(&mut ws_sink, "MESSAGE_TOO_LARGE", "message payload exceeds 65536 bytes").await;
                            continue;
                        }

                        let client_msg: ClientMessage = match serde_json::from_str(&text_str) {
                            Ok(m) => m,
                            Err(_) => continue,
                        };

                        // Handle heartbeat inline to update last_heartbeat
                        if client_msg.op == ClientOp::Heartbeat {
                            last_heartbeat = Instant::now();
                            let _ = presence::refresh_presence(&state.redis, &user_id).await;
                            let ack = ServerMessage {
                                t: ServerEvent::HEARTBEAT_ACK,
                                d: serde_json::json!({}),
                                seq: None,
                            };
                            let ack_json = serde_json::to_string(&ack).unwrap_or_default();
                            let _ = ws_sink.send(Message::Text(ack_json.into())).await;
                        } else {
                            handle_client_op(&state, &mut ws_sink, user_id, &device_id, client_msg).await;
                        }
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        // MessagePack binary frame — check size limit
                        if bytes.len() > MAX_MESSAGE_PAYLOAD_SIZE {
                            send_error_json(&mut ws_sink, "MESSAGE_TOO_LARGE", "message payload exceeds 65536 bytes").await;
                            continue;
                        }

                        let client_msg: BinaryClientMessage = match rmp_serde::from_slice(&bytes) {
                            Ok(m) => m,
                            Err(_) => continue,
                        };

                        handle_binary_client_op(&state, &mut ws_sink, user_id, &device_id, client_msg).await;
                    }
                    Some(Ok(Message::Close(_))) => break,
                    Some(Err(_)) => break,
                    None => break,
                    _ => {} // Ping/Pong handled by axum automatically
                }
            }

            // Heartbeat check: disconnect if 3 intervals have passed without heartbeat
            _ = heartbeat_check.tick() => {
                if last_heartbeat.elapsed() > heartbeat_timeout {
                    tracing::info!(
                        "heartbeat timeout for user {} session {}",
                        user_id, session_id
                    );
                    let _ = ws_sink.send(Message::Close(Some(CloseFrame {
                        code: close_codes::SESSION_EXPIRED,
                        reason: "heartbeat timeout".into(),
                    }))).await;
                    break;
                }
            }
        }
    }

    // Connection ended — cleanup
    tracing::debug!("run_event_loop: exited for user={user_id} session={session_id}");
    cleanup_connection(&state, &session_id, user_id, &device_id).await;
}

/// Handle a JSON text-frame client operation.
async fn handle_client_op(
    state: &AppState,
    ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    user_id: UserId,
    _device_id: &str,
    client_msg: ClientMessage,
) {
    match client_msg.op {
        ClientOp::Heartbeat => {
            // Handled inline in event loop (needs access to last_heartbeat)
        }
        ClientOp::PresenceUpdate => {
            if let Ok(payload) =
                serde_json::from_value::<PresenceUpdatePayload>(client_msg.d)
            {
                match payload.status.as_str() {
                    "online" | "idle" | "dnd" | "offline" => {
                        let _ = presence::update_status(
                            &state.redis,
                            &state.ws_manager,
                            user_id,
                            &payload.status,
                        )
                        .await;
                    }
                    _ => {} // Invalid status, ignore
                }
            }
        }
        ClientOp::TypingStart => {
            if let Ok(payload) =
                serde_json::from_value::<TypingStartPayload>(client_msg.d)
            {
                let typing_key = format!("typing:{}:{}", payload.channel_id, user_id);
                let _ = state
                    .redis
                    .set::<(), _, _>(
                        &typing_key,
                        "1",
                        Some(Expiration::EX(5)),
                        None,
                        false,
                    )
                    .await;

                // Broadcast typing event
                let event = ServerMessage {
                    t: ServerEvent::TYPING_START,
                    d: serde_json::json!({
                        "channel_id": payload.channel_id,
                        "user_id": user_id.to_string(),
                    }),
                    seq: None,
                };
                let connected = state.ws_manager.connected_user_ids();
                state.ws_manager.send_to_users(&connected, &event);
            }
        }
        ClientOp::MessageSend => {
            // JSON text frame message_send = standard channel message
            if let Ok(payload) =
                serde_json::from_value::<MessageSendPayload>(client_msg.d)
            {
                // Check size (JSON text frame payloads)
                handle_standard_message_send(state, ws_sink, user_id, payload).await;
            }
        }
        ClientOp::VoiceStateUpdate => {
            if let Ok(payload) =
                serde_json::from_value::<VoiceStateUpdatePayload>(client_msg.d)
            {
                handle_voice_state_update(state, ws_sink, user_id, _device_id, payload).await;
            }
        }
        ClientOp::WebrtcSignal => {
            if let Ok(payload) =
                serde_json::from_value::<WebrtcSignalPayload>(client_msg.d)
            {
                handle_webrtc_signal(state, ws_sink, user_id, payload).await;
            }
        }
        _ => {}
    }
}

/// Handle a MessagePack binary-frame client operation.
async fn handle_binary_client_op(
    state: &AppState,
    ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    user_id: UserId,
    device_id: &str,
    client_msg: BinaryClientMessage,
) {
    match client_msg.op {
        ClientOp::MessageSend => {
            // Binary frame message_send — could be DM or private channel
            // Try to determine the type from the payload fields
            handle_binary_message_send(state, ws_sink, user_id, device_id, client_msg.d).await;
        }
        ClientOp::SenderKeyDistribute => {
            handle_sender_key_distribute(state, ws_sink, user_id, device_id, client_msg.d).await;
        }
        ClientOp::MediaKeyDistribute => {
            handle_media_key_distribute(state, user_id, device_id, client_msg.d).await;
        }
        _ => {}
    }
}

/// Handle a standard channel message_send (JSON text frame, plaintext).
async fn handle_standard_message_send(
    state: &AppState,
    ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    sender_id: UserId,
    payload: MessageSendPayload,
) {
    // Per-user rate limit
    if !check_message_rate_limit(state, sender_id).await {
        send_error_json(ws_sink, "RATE_LIMITED", "message send rate limit exceeded").await;
        return;
    }

    // Parse channel_id
    let channel_uuid = match uuid::Uuid::parse_str(&payload.channel_id) {
        Ok(u) => u,
        Err(_) => return,
    };
    let channel_id = ChannelId(channel_uuid);

    // Look up the channel to get server_id and encryption_mode
    let channel = match channels::get_channel_by_id(&state.db, channel_id).await {
        Ok(Some(c)) => c,
        _ => return,
    };

    // Enforce content length limit
    if let Some(ref content) = payload.content {
        if content.len() > MAX_MESSAGE_CONTENT_LENGTH {
            send_error_json(
                ws_sink,
                "CONTENT_TOO_LONG",
                "message content exceeds 4000 characters",
            )
            .await;
            return;
        }
    }

    // Reject standard messages on private/E2E channels
    if channel.encryption_mode != "standard" {
        send_error_json(
            ws_sink,
            "INVALID_ENCRYPTION_MODE",
            "use encrypted payload for non-standard channels",
        )
        .await;
        return;
    }

    // Verify sender is a member of this server
    let is_member = mercury_db::servers::is_member(&state.db, sender_id, channel.server_id)
        .await
        .unwrap_or(false);
    if !is_member {
        return;
    }

    // Check if sender is muted in this channel
    if mercury_moderation::mutes::is_muted(&state.db, &state.redis, channel_id, sender_id).await {
        send_error_json(ws_sink, "CHANNEL_MUTED", "you are muted in this channel").await;
        return;
    }

    let content = payload.content.as_deref();

    let message_id = MessageId::new();
    let message = match mercury_db::messages::create_message(
        &state.db,
        message_id,
        channel_id,
        sender_id,
        content,
    )
    .await
    {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("failed to store message: {e}");
            return;
        }
    };

    // Build MESSAGE_CREATE event — use MessagePack binary frame
    let create_payload = MessageCreatePayload {
        id: message.id.to_string(),
        channel_id: channel_id.to_string(),
        sender_id: sender_id.to_string(),
        content: message.content,
        created_at: message
            .created_at
            .map(|t| t.to_rfc3339())
            .unwrap_or_default(),
    };

    let bytes = encode_msgpack_server_message(
        ServerEvent::MESSAGE_CREATE,
        &create_payload,
        None,
    );

    // Broadcast to all connected members of this server
    let member_ids = mercury_db::servers::get_member_user_ids(&state.db, channel.server_id)
        .await
        .unwrap_or_default();
    state.ws_manager.send_binary_to_users(&member_ids, &bytes);
}

/// Handle a binary message_send — determine if it's a DM or private channel message.
async fn handle_binary_message_send(
    state: &AppState,
    ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    sender_id: UserId,
    sender_device_id: &str,
    data: rmpv::Value,
) {
    // Check which fields are present to determine message type
    let has_dm_channel_id = data.as_map().map_or(false, |m| {
        m.iter().any(|(k, _)| k.as_str() == Some("dm_channel_id"))
    });
    let has_encrypted = data.as_map().map_or(false, |m| {
        m.iter().any(|(k, _)| k.as_str() == Some("encrypted"))
    });

    // Reject ambiguous payloads that contain both DM and private channel fields
    if has_dm_channel_id && has_encrypted {
        send_error_json(
            ws_sink,
            "BAD_REQUEST",
            "payload must not contain both dm_channel_id and encrypted",
        )
        .await;
        return;
    }

    if has_dm_channel_id {
        // E2E DM message
        let payload: DmMessageSendPayload = match rmpv::ext::from_value(data) {
            Ok(p) => p,
            Err(e) => {
                tracing::debug!("invalid DM message_send payload: {e}");
                return;
            }
        };
        handle_dm_message_send(state, ws_sink, sender_id, sender_device_id, payload).await;
    } else if has_encrypted {
        // Private channel (Sender Key) message
        let payload: PrivateMessageSendPayload = match rmpv::ext::from_value(data) {
            Ok(p) => p,
            Err(e) => {
                tracing::debug!("invalid private channel message_send payload: {e}");
                return;
            }
        };
        handle_private_message_send(state, ws_sink, sender_id, payload).await;
    } else {
        tracing::debug!("binary message_send missing dm_channel_id or encrypted field");
    }
}

/// Handle an E2E DM message_send.
async fn handle_dm_message_send(
    state: &AppState,
    ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    sender_id: UserId,
    _sender_device_id: &str,
    payload: DmMessageSendPayload,
) {
    // Per-user rate limit
    if !check_message_rate_limit(state, sender_id).await {
        send_error_json(ws_sink, "RATE_LIMITED", "message send rate limit exceeded").await;
        return;
    }

    // Parse dm_channel_id
    let dm_channel_uuid = match uuid::Uuid::parse_str(&payload.dm_channel_id) {
        Ok(u) => u,
        Err(_) => return,
    };
    let dm_channel_id = DmChannelId(dm_channel_uuid);

    // Validate membership
    let is_member = mercury_db::dm_channels::is_dm_member(&state.db, sender_id, dm_channel_id)
        .await
        .unwrap_or(false);
    if !is_member {
        return;
    }

    // Block enforcement: silently drop if either user has blocked the other.
    // No error is sent to prevent information leakage about block status.
    if let Ok(Some(recipient_id)) =
        mercury_db::dm_channels::get_dm_recipient(&state.db, dm_channel_id, sender_id).await
    {
        // Check if recipient blocked sender OR sender blocked recipient
        if mercury_moderation::blocks::is_blocked(&state.redis, recipient_id, sender_id).await
            || mercury_moderation::blocks::is_blocked(&state.redis, sender_id, recipient_id).await
        {
            return;
        }
    }

    // Validate non-empty recipients
    if payload.recipients.is_empty() {
        send_error_json(ws_sink, "BAD_REQUEST", "recipients array is empty").await;
        return;
    }

    // Use a transaction so message + all recipients are atomic
    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            tracing::warn!("failed to begin transaction for DM message: {e}");
            return;
        }
    };

    // Create the message row (content = NULL for E2E DMs)
    let message_id = MessageId::new();
    let message = match mercury_db::messages::create_dm_message(
        &mut *tx,
        message_id,
        dm_channel_id,
        sender_id,
    )
    .await
    {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("failed to store DM message: {e}");
            return;
        }
    };

    let created_at = message
        .created_at
        .map(|t| t.to_rfc3339())
        .unwrap_or_default();

    // Store per-device ciphertexts within the transaction
    for recipient in &payload.recipients {
        let device_uuid = match uuid::Uuid::parse_str(&recipient.device_id) {
            Ok(u) => u,
            Err(_) => continue,
        };
        let device_id = DeviceId(device_uuid);

        // Serialize x3dh_header as MessagePack with named map keys so the
        // client can parse it with named property access from REST history.
        let x3dh_header_bytes = recipient.x3dh_header.as_ref().map(|h| {
            rmp_serde::to_vec_named(h).unwrap_or_default()
        });

        // Store in message_recipients
        if let Err(e) = mercury_db::messages::create_message_recipient(
            &mut *tx,
            message_id,
            Some(device_id),
            &recipient.ciphertext,
            x3dh_header_bytes.as_deref(),
        )
        .await
        {
            tracing::warn!("failed to store message recipient: {e}");
            // Roll back entire message on recipient insert failure
            return;
        }
    }

    // Commit the transaction — all inserts succeeded
    if let Err(e) = tx.commit().await {
        tracing::warn!("failed to commit DM message transaction: {e}");
        return;
    }

    // Broadcast per-device MESSAGE_CREATE events (after commit)
    for recipient in &payload.recipients {
        let x3dh_payload = recipient.x3dh_header.as_ref().map(|h| X3dhHeaderPayload {
            sender_identity_key: h.sender_identity_key.clone(),
            ephemeral_key: h.ephemeral_key.clone(),
            prekey_id: h.prekey_id,
        });

        let create_payload = DmMessageCreatePayload {
            id: message_id.to_string(),
            dm_channel_id: dm_channel_id.to_string(),
            sender_id: sender_id.to_string(),
            ciphertext: recipient.ciphertext.clone(),
            x3dh_header: x3dh_payload,
            created_at: created_at.clone(),
        };

        let bytes = encode_msgpack_server_message(
            ServerEvent::MESSAGE_CREATE,
            &create_payload,
            None,
        );

        // Send to the target device
        state.ws_manager.send_binary_to_device(&recipient.device_id, &bytes);
    }
}

/// Handle a private channel (Sender Key) message_send.
async fn handle_private_message_send(
    state: &AppState,
    ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    sender_id: UserId,
    payload: PrivateMessageSendPayload,
) {
    // Per-user rate limit
    if !check_message_rate_limit(state, sender_id).await {
        send_error_json(ws_sink, "RATE_LIMITED", "message send rate limit exceeded").await;
        return;
    }

    // Parse channel_id
    let channel_uuid = match uuid::Uuid::parse_str(&payload.channel_id) {
        Ok(u) => u,
        Err(_) => return,
    };
    let channel_id = ChannelId(channel_uuid);

    // Look up the channel
    let channel = match channels::get_channel_by_id(&state.db, channel_id).await {
        Ok(Some(c)) => c,
        _ => return,
    };

    // Verify sender is a member of this server AND this private channel
    let is_member = mercury_db::servers::is_member(&state.db, sender_id, channel.server_id)
        .await
        .unwrap_or(false);
    if !is_member {
        return;
    }
    let is_channel_member =
        channels::is_channel_member(&state.db, sender_id, channel_id)
            .await
            .unwrap_or(false);
    if !is_channel_member {
        return;
    }

    // Check if sender is muted in this channel
    if mercury_moderation::mutes::is_muted(&state.db, &state.redis, channel_id, sender_id).await {
        send_error_json(ws_sink, "CHANNEL_MUTED", "you are muted in this channel").await;
        return;
    }

    // Epoch validation — reject if message epoch < channel's sender_key_epoch
    if payload.encrypted.epoch < channel.sender_key_epoch {
        send_error_json(
            ws_sink,
            "STALE_SENDER_KEY",
            "sender key epoch is stale, re-key required",
        )
        .await;
        return;
    }

    // Use a transaction so message + recipient are atomic
    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            tracing::warn!("failed to begin transaction for private message: {e}");
            return;
        }
    };

    // Create the message row (content = NULL for private channels)
    let message_id = MessageId::new();
    let message = match mercury_db::messages::create_message(
        &mut *tx,
        message_id,
        channel_id,
        sender_id,
        None,
    )
    .await
    {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("failed to store private channel message: {e}");
            return;
        }
    };

    // Store the broadcast ciphertext (device_id = NULL).
    // Use to_vec_named so the blob has named map keys matching the struct fields.
    // This ensures REST endpoints can return it in a format the client can parse
    // with named property access (e.g., encrypted.ciphertext, encrypted.nonce).
    let encrypted_blob = rmp_serde::to_vec_named(&payload.encrypted).unwrap_or_default();
    if let Err(e) = mercury_db::messages::create_message_recipient(
        &mut *tx,
        message_id,
        None, // broadcast
        &encrypted_blob,
        None,
    )
    .await
    {
        tracing::warn!("failed to store private channel recipient: {e}");
        return;
    }

    // Commit the transaction
    if let Err(e) = tx.commit().await {
        tracing::warn!("failed to commit private message transaction: {e}");
        return;
    }

    let created_at = message
        .created_at
        .map(|t| t.to_rfc3339())
        .unwrap_or_default();

    // Build MESSAGE_CREATE payload with the encrypted data
    let create_payload = PrivateMessageCreatePayload {
        id: message_id.to_string(),
        channel_id: channel_id.to_string(),
        sender_id: sender_id.to_string(),
        encrypted: payload.encrypted,
        created_at,
    };

    let bytes = encode_msgpack_server_message(
        ServerEvent::MESSAGE_CREATE,
        &create_payload,
        None,
    );

    // Broadcast to channel members only (not all server members)
    let member_ids = channels::get_channel_member_user_ids(&state.db, channel_id)
        .await
        .unwrap_or_default();
    state.ws_manager.send_binary_to_users(&member_ids, &bytes);
}

/// Handle sender_key_distribute op.
async fn handle_sender_key_distribute(
    state: &AppState,
    _ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    sender_id: UserId,
    sender_device_id: &str,
    data: rmpv::Value,
) {
    let payload: SenderKeyDistributePayload = match rmpv::ext::from_value(data) {
        Ok(p) => p,
        Err(e) => {
            tracing::debug!("invalid sender_key_distribute payload: {e}");
            return;
        }
    };

    // Parse channel_id and verify membership
    let channel_uuid = match uuid::Uuid::parse_str(&payload.channel_id) {
        Ok(u) => u,
        Err(_) => return,
    };
    let channel_id = ChannelId(channel_uuid);

    let channel = match channels::get_channel_by_id(&state.db, channel_id).await {
        Ok(Some(c)) => c,
        _ => return,
    };

    // Only allow sender key distribution on private channels
    if channel.encryption_mode != "private" {
        send_error_json(
            _ws_sink,
            "INVALID_ENCRYPTION_MODE",
            "sender key distribution is only allowed on private channels",
        )
        .await;
        return;
    }

    let is_member = mercury_db::servers::is_member(&state.db, sender_id, channel.server_id)
        .await
        .unwrap_or(false);
    if !is_member {
        return;
    }
    let is_channel_member =
        channels::is_channel_member(&state.db, sender_id, channel_id)
            .await
            .unwrap_or(false);
    if !is_channel_member {
        return;
    }

    // For each distribution, deliver to the target device
    for dist in &payload.distributions {
        let event_payload = SenderKeyDistributionEvent {
            channel_id: payload.channel_id.clone(),
            sender_id: sender_id.to_string(),
            sender_device_id: sender_device_id.to_string(),
            ciphertext: dist.ciphertext.clone(),
        };

        let bytes = encode_msgpack_server_message(
            ServerEvent::SENDER_KEY_DISTRIBUTION,
            &event_payload,
            None,
        );

        // Deliver to the target device if online
        state.ws_manager.send_binary_to_device(&dist.device_id, &bytes);

        // Store for offline delivery as a system message (in a transaction)
        let mut tx = match state.db.begin().await {
            Ok(tx) => tx,
            Err(e) => {
                tracing::warn!("failed to begin transaction for sender key storage: {e}");
                continue;
            }
        };

        let msg_id = MessageId::new();
        if let Ok(_msg) = mercury_db::messages::create_sender_key_distribution_message(
            &mut *tx,
            msg_id,
            channel_id,
            sender_id,
        )
        .await
        {
            // Store as a message_recipient for the target device
            let target_device = uuid::Uuid::parse_str(&dist.device_id).ok().map(DeviceId);
            if let Some(target_device_id) = target_device {
                // Encode the full distribution event as the ciphertext (named map
                // format so it can be parsed by clients from REST history).
                let dist_blob = rmp_serde::to_vec_named(&event_payload).unwrap_or_default();
                let _ = mercury_db::messages::create_message_recipient(
                    &mut *tx,
                    msg_id,
                    Some(target_device_id),
                    &dist_blob,
                    None,
                )
                .await;
            }
        }

        let _ = tx.commit().await;
    }
}

/// Handle media_key_distribute: relay DR-encrypted media keys to call participants.
///
/// This is an ephemeral relay — media keys are not persisted to the database.
/// Each recipient entry is delivered as a MEDIA_KEY event to the target device.
async fn handle_media_key_distribute(
    state: &AppState,
    sender_id: UserId,
    sender_device_id: &str,
    data: rmpv::Value,
) {
    let payload: MediaKeyDistributePayload = match rmpv::ext::from_value(data) {
        Ok(p) => p,
        Err(e) => {
            tracing::debug!("invalid media_key_distribute payload: {e}");
            return;
        }
    };

    // Verify sender is actually in the specified room
    let room = state.sfu_handle.get_room(payload.room_id.clone()).await;
    let is_in_room = room
        .as_ref()
        .map(|r| {
            r.participants
                .iter()
                .any(|p| p.user_id == sender_id.to_string())
        })
        .unwrap_or(false);
    if !is_in_room {
        tracing::debug!(
            "media_key_distribute rejected: user {} not in room {}",
            sender_id,
            payload.room_id
        );
        return;
    }

    // Relay each per-device ciphertext to the target device
    for recipient in &payload.recipients {
        let event_payload = MediaKeyEvent {
            room_id: payload.room_id.clone(),
            sender_id: sender_id.to_string(),
            sender_device_id: sender_device_id.to_string(),
            ciphertext: recipient.ciphertext.clone(),
        };

        let bytes = encode_msgpack_server_message(
            ServerEvent::MEDIA_KEY,
            &event_payload,
            None,
        );

        // Deliver to target device — ephemeral (no offline storage for media keys)
        state.ws_manager.send_binary_to_device(&recipient.device_id, &bytes);
    }
}

// ── Voice / Call Handlers ───────────────────────────────────

/// Handle voice_state_update: join/leave voice channel, update mute/deaf.
/// Supports both server voice channels and DM channels.
async fn handle_voice_state_update(
    state: &AppState,
    ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    user_id: UserId,
    device_id: &str,
    payload: VoiceStateUpdatePayload,
) {
    match payload.channel_id {
        Some(channel_id_str) => {
            // Join a voice channel
            let channel_uuid = match uuid::Uuid::parse_str(&channel_id_str) {
                Ok(u) => u,
                Err(_) => {
                    send_error_json(ws_sink, "BAD_REQUEST", "invalid channel_id").await;
                    return;
                }
            };
            let channel_id = ChannelId(channel_uuid);

            // Try server channel first, then DM channel
            let server_id = match channels::get_channel_by_id(&state.db, channel_id).await {
                Ok(Some(channel)) => {
                    // Server channel — must be voice or video
                    if channel.channel_type != "voice" && channel.channel_type != "video" {
                        send_error_json(ws_sink, "BAD_REQUEST", "channel is not a voice/video channel").await;
                        return;
                    }
                    // Check server membership
                    let is_member = servers::is_member(&state.db, user_id, channel.server_id)
                        .await
                        .unwrap_or(false);
                    if !is_member {
                        send_error_json(ws_sink, "FORBIDDEN", "not a member of this server").await;
                        return;
                    }
                    Some(channel.server_id)
                }
                _ => {
                    // Try as DM channel
                    let dm_channel_id = DmChannelId(channel_uuid);
                    match mercury_db::dm_channels::get_dm_channel_by_id(&state.db, dm_channel_id).await {
                        Ok(Some(_)) => {
                            // DM channel — check DM membership
                            let is_dm_member = mercury_db::dm_channels::is_dm_member(
                                &state.db, user_id, dm_channel_id,
                            )
                            .await
                            .unwrap_or(false);
                            if !is_dm_member {
                                send_error_json(ws_sink, "FORBIDDEN", "not a member of this DM channel").await;
                                return;
                            }
                            None // DM calls have no server_id
                        }
                        _ => {
                            send_error_json(ws_sink, "NOT_FOUND", "channel not found").await;
                            return;
                        }
                    }
                }
            };

            // Join via SFU
            match state
                .sfu_handle
                .join_room(user_id, device_id.to_string(), channel_id, server_id)
                .await
            {
                Ok(join_result) => {
                    // Generate CALL_CONFIG with TURN credentials
                    let turn_creds = mercury_auth::turn::generate_turn_credentials(
                        &user_id.to_string(),
                        &mercury_core::config::TurnConfig {
                            enabled: true,
                            secret: if state.media_config.ice.turn_secret.is_empty() {
                                state.turn_config.secret.clone()
                            } else {
                                state.media_config.ice.turn_secret.clone()
                            },
                            urls: state.media_config.ice.turn_urls.clone(),
                            credential_ttl_seconds: state.turn_config.credential_ttl_seconds,
                        },
                    );

                    let call_config = CallConfigEvent {
                        room_id: join_result.room_id.clone(),
                        turn_urls: turn_creds.urls,
                        stun_urls: state.media_config.ice.stun_urls.clone(),
                        username: turn_creds.username,
                        credential: turn_creds.credential,
                        ttl: turn_creds.ttl,
                        audio: AudioLimitsPayload {
                            max_bitrate_kbps: state.media_config.audio.max_bitrate_kbps,
                            preferred_bitrate_kbps: state.media_config.audio.preferred_bitrate_kbps,
                        },
                        video: VideoLimitsPayload {
                            max_bitrate_kbps: state.media_config.video.max_bitrate_kbps,
                            max_resolution: state.media_config.video.max_resolution.clone(),
                            max_framerate: state.media_config.video.max_framerate,
                            simulcast_enabled: state.media_config.video.simulcast_enabled,
                            simulcast_layers: state.media_config.video.simulcast_layers.clone(),
                        },
                    };

                    // Send CALL_CONFIG to the joining user
                    let config_msg = ServerMessage {
                        t: ServerEvent::CALL_CONFIG,
                        d: serde_json::to_value(&call_config).unwrap_or_default(),
                        seq: None,
                    };
                    let config_json = serde_json::to_string(&config_msg).unwrap_or_default();
                    let _ = ws_sink.send(Message::Text(config_json.into())).await;

                    // If user is already in room and just updating mute/deaf state
                    if payload.self_mute || payload.self_deaf {
                        let _ = state
                            .sfu_handle
                            .update_voice_state(user_id, channel_id, payload.self_mute, payload.self_deaf)
                            .await;
                    }
                }
                Err(mercury_media::SfuError::RoomFull) => {
                    send_error_json(ws_sink, "ROOM_FULL", "room has reached maximum participants").await;
                }
                Err(e) => {
                    send_error_json(ws_sink, "INTERNAL_ERROR", &e.to_string()).await;
                }
            }
        }
        None => {
            // Leave: channel_id is null
            let _ = state.sfu_handle.leave_all(user_id).await;
        }
    }
}

/// Handle webrtc_signal: relay SDP offer/answer and ICE candidates.
async fn handle_webrtc_signal(
    state: &AppState,
    ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    user_id: UserId,
    payload: WebrtcSignalPayload,
) {
    match state
        .sfu_handle
        .webrtc_signal(user_id, payload.room_id, payload.signal)
        .await
    {
        Ok(Some(answer)) => {
            // Send the SDP answer back to the client
            let event = ServerMessage {
                t: ServerEvent::WEBRTC_SIGNAL,
                d: serde_json::to_value(WebrtcSignalEvent {
                    from_user: "sfu".to_string(),
                    signal: answer,
                })
                .unwrap_or_default(),
                seq: None,
            };
            let json = serde_json::to_string(&event).unwrap_or_default();
            let _ = ws_sink.send(Message::Text(json.into())).await;
        }
        Ok(None) => {
            // No response needed (e.g., ICE candidate was relayed)
        }
        Err(mercury_media::SfuError::RoomNotFound) => {
            send_error_json(ws_sink, "NOT_FOUND", "room not found").await;
        }
        Err(mercury_media::SfuError::NotInRoom) => {
            send_error_json(ws_sink, "FORBIDDEN", "not in this room").await;
        }
        Err(e) => {
            send_error_json(ws_sink, "INTERNAL_ERROR", &e.to_string()).await;
        }
    }
}

/// Maximum content length for standard (plaintext) messages in characters.
const MAX_MESSAGE_CONTENT_LENGTH: usize = 4000;

/// Per-user rate limit for message_send operations.
/// Uses a Redis counter with a 1-second sliding window.
/// Returns true if allowed, false if rate limited.
const MESSAGE_SEND_RATE_LIMIT: u64 = 10; // messages per second per user

async fn check_message_rate_limit(state: &AppState, user_id: UserId) -> bool {
    let key = format!("rate:msg:{}", user_id);
    let now_micros = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_micros() as f64;
    let window_micros = 1_000_000.0; // 1 second
    let cutoff = now_micros - window_micros;

    // Remove entries older than the window
    let _ = state.redis.zremrangebyscore::<i64, _, _, _>(&key, f64::NEG_INFINITY, cutoff).await;

    // Count entries in the current window
    let count: u64 = state.redis.zcard(&key).await.unwrap_or(0);
    if count >= MESSAGE_SEND_RATE_LIMIT {
        return false;
    }

    // Add the new request
    let member = format!("{now_micros}");
    let _ = state.redis.zadd::<i64, _, _>(&key, None, None, false, false, (now_micros, member)).await;
    let _ = state.redis.expire::<bool, _>(&key, 2).await;

    true
}

/// Send a JSON error event.
async fn send_error_json(
    ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    code: &str,
    message: &str,
) {
    let error = ServerMessage {
        t: ServerEvent::ERROR,
        d: serde_json::to_value(ErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
        })
        .unwrap_or_default(),
        seq: None,
    };
    let json = serde_json::to_string(&error).unwrap_or_default();
    let _ = ws_sink.send(Message::Text(json.into())).await;
}

/// Inject a seq field into a pre-encoded MessagePack binary.
/// Decodes the map, adds "seq" key, re-encodes.
fn inject_seq_into_msgpack(bytes: &[u8], seq: u64) -> Vec<u8> {
    match rmpv::decode::read_value(&mut &bytes[..]) {
        Ok(rmpv::Value::Map(mut pairs)) => {
            pairs.push((
                rmpv::Value::String("seq".into()),
                rmpv::Value::Integer(seq.into()),
            ));
            let map = rmpv::Value::Map(pairs);
            let mut buf = Vec::new();
            rmpv::encode::write_value(&mut buf, &map).unwrap_or_default();
            buf
        }
        _ => bytes.to_vec(), // fallback: return as-is
    }
}

/// Clean up after a connection closes.
async fn cleanup_connection(
    state: &AppState,
    session_id: &str,
    user_id: UserId,
    device_id: &str,
) {
    // Remove the connection handle (but keep session state for resume)
    state.ws_manager.remove_connection(session_id);

    // Leave all voice rooms on disconnect
    if let Err(e) = state.sfu_handle.leave_all(user_id).await {
        tracing::warn!("failed to leave_all on disconnect: {e}");
    }

    // Start offline debounce (only broadcasts offline after 15s if no reconnect)
    if let Err(e) =
        presence::begin_offline_debounce(&state.redis, state.ws_manager.clone(), user_id, device_id)
            .await
    {
        tracing::warn!("failed to begin offline debounce: {e}");
    }

    // Schedule session cleanup after resume window expires
    let manager = state.ws_manager.clone();
    let session_id_owned = session_id.to_string();
    tokio::spawn(async move {
        time::sleep(Duration::from_secs(SESSION_RESUME_WINDOW_SECS)).await;
        // Only remove if no new connection has claimed this session
        if !manager.is_user_connected(&user_id) {
            manager.remove_session(&session_id_owned);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_timeout_detection() {
        // With 30s interval and 3 miss limit, timeout is 90s.
        let interval = Duration::from_secs(HEARTBEAT_INTERVAL_SECS);
        let timeout = interval * HEARTBEAT_MISS_LIMIT;

        assert_eq!(timeout, Duration::from_secs(90));

        // Simulate: last heartbeat was 89s ago — should NOT timeout
        let last = Instant::now() - Duration::from_secs(89);
        assert!(last.elapsed() <= timeout);

        // Simulate: last heartbeat was 91s ago — should timeout
        let last = Instant::now() - Duration::from_secs(91);
        assert!(last.elapsed() > timeout);
    }

    #[test]
    fn heartbeat_miss_limit_is_three() {
        assert_eq!(HEARTBEAT_MISS_LIMIT, 3);
    }

    #[test]
    fn heartbeat_interval_is_30s() {
        assert_eq!(HEARTBEAT_INTERVAL_SECS, 30);
    }

    #[test]
    fn inject_seq_into_msgpack_works() {
        // Create a simple MessagePack map
        let map = rmpv::Value::Map(vec![
            (rmpv::Value::String("t".into()), rmpv::Value::String("MESSAGE_CREATE".into())),
            (rmpv::Value::String("d".into()), rmpv::Value::Nil),
        ]);
        let mut buf = Vec::new();
        rmpv::encode::write_value(&mut buf, &map).unwrap();

        let result = inject_seq_into_msgpack(&buf, 42);
        let decoded = rmpv::decode::read_value(&mut &result[..]).unwrap();
        let pairs = decoded.as_map().unwrap();
        let seq_val = pairs.iter().find(|(k, _)| k.as_str() == Some("seq")).unwrap().1.as_u64();
        assert_eq!(seq_val, Some(42));
    }
}
