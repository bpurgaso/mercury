use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use fred::prelude::*;
use futures_util::{SinkExt, StreamExt};
use mercury_auth::jwt;
use mercury_core::ids::UserId;
use mercury_db::users;
use tokio::sync::mpsc;
use tokio::time::{self, Duration, Instant};

use crate::state::AppState;

use super::manager::{ConnectionHandle, SessionState};
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

    tracing::debug!("handle_identify: session created, sending READY");

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
        servers: vec![],
        dm_channels: vec![],
        session_id: session_id.clone(),
        heartbeat_interval: state.heartbeat_interval_secs,
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

    for event_json in &missed_events {
        if ws_sink
            .send(Message::Text(event_json.clone().into()))
            .await
            .is_err()
        {
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
    mut rx: mpsc::UnboundedReceiver<ServerMessage>,
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
                let mut msg = event;
                msg.seq = Some(seq);

                let json = match serde_json::to_string(&msg) {
                    Ok(j) => j,
                    Err(_) => continue,
                };

                // Buffer for potential replay
                session_state.buffer_event(seq, json.clone());

                if ws_sink.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }

            // Incoming: client messages
            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let text_str = text.to_string();
                        let client_msg: ClientMessage = match serde_json::from_str(&text_str) {
                            Ok(m) => m,
                            Err(_) => continue,
                        };

                        match client_msg.op {
                            ClientOp::Heartbeat => {
                                last_heartbeat = Instant::now();

                                // Refresh presence TTL
                                let _ = presence::refresh_presence(&state.redis, &user_id).await;

                                // Send HEARTBEAT_ACK
                                let ack = ServerMessage {
                                    t: ServerEvent::HEARTBEAT_ACK,
                                    d: serde_json::json!({}),
                                    seq: None,
                                };
                                let ack_json = serde_json::to_string(&ack).unwrap_or_default();
                                if ws_sink.send(Message::Text(ack_json.into())).await.is_err() {
                                    break;
                                }
                            }
                            ClientOp::PresenceUpdate => {
                                if let Ok(payload) = serde_json::from_value::<PresenceUpdatePayload>(client_msg.d) {
                                    match payload.status.as_str() {
                                        "online" | "idle" | "dnd" | "offline" => {
                                            let _ = presence::update_status(
                                                &state.redis,
                                                &state.ws_manager,
                                                user_id,
                                                &payload.status,
                                            ).await;
                                        }
                                        _ => {} // Invalid status, ignore
                                    }
                                }
                            }
                            ClientOp::TypingStart => {
                                if let Ok(payload) = serde_json::from_value::<TypingStartPayload>(client_msg.d) {
                                    let typing_key = format!("typing:{}:{}", payload.channel_id, user_id);
                                    let _ = state.redis.set::<(), _, _>(
                                        &typing_key,
                                        "1",
                                        Some(Expiration::EX(5)),
                                        None,
                                        false,
                                    ).await;

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
                            // Other ops not yet implemented in Phase 4
                            _ => {}
                        }
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

/// Clean up after a connection closes.
async fn cleanup_connection(
    state: &AppState,
    session_id: &str,
    user_id: UserId,
    device_id: &str,
) {
    // Remove the connection handle (but keep session state for resume)
    state.ws_manager.remove_connection(session_id);

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
}
