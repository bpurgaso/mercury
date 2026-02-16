use axum::{
    extract::{Query, State},
    extract::ws::{CloseFrame, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use mercury_auth::jwt;
use rand::Rng;
use serde::Deserialize;

use crate::state::AppState;
use crate::ws::connection;
use crate::ws::protocol::close_codes;

/// Query parameters for the WebSocket upgrade endpoint.
#[derive(Debug, Deserialize)]
pub struct WsQueryParams {
    pub token: String,
}

/// WebSocket upgrade handler at `/ws?token={jwt}`.
///
/// Flow:
/// 1. Check global WS rate limiter (200/sec) → 503 if saturated
/// 2. Validate JWT from query parameter
/// 3. If invalid: upgrade then immediately close with 4008
/// 4. If valid: upgrade and hand off to connection handler
pub async fn ws_upgrade(
    State(state): State<AppState>,
    Query(params): Query<WsQueryParams>,
    ws: WebSocketUpgrade,
) -> Response {
    tracing::debug!("ws_upgrade: handler entered, token length={}", params.token.len());

    // Global rate limit check (thundering herd protection)
    if !state.ws_rate_limiter.try_acquire() {
        let retry_after = rand::thread_rng().gen_range(5..30);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [("Retry-After", retry_after.to_string())],
            "Server busy, retry later",
        )
            .into_response();
    }

    tracing::debug!("ws_upgrade: rate limit passed");

    // Validate JWT before upgrading
    let claims = match jwt::validate_token(&state.auth_config, &params.token) {
        Ok(token_data) => {
            tracing::debug!("ws_upgrade: JWT valid, token_type={}", token_data.claims.token_type);
            // Must be an access token
            if token_data.claims.token_type != "access" {
                return ws
                    .on_upgrade(|mut socket| async move {
                        let _ = socket
                            .send(axum::extract::ws::Message::Close(Some(CloseFrame {
                                code: close_codes::INVALID_TOKEN,
                                reason: "expected access token".into(),
                            })))
                            .await;
                    })
                    .into_response();
            }
            token_data.claims
        }
        Err(e) => {
            tracing::debug!("ws_upgrade: JWT validation failed: {e}");
            // Invalid or expired token — upgrade then close with 4008
            return ws
                .on_upgrade(|mut socket| async move {
                    let _ = socket
                        .send(axum::extract::ws::Message::Close(Some(CloseFrame {
                            code: close_codes::INVALID_TOKEN,
                            reason: "invalid or expired token".into(),
                        })))
                        .await;
                })
                .into_response();
        }
    };

    // Verify session exists in Redis
    let redis = state.redis.clone();
    let jti = claims.jti.clone();
    let session_exists = mercury_auth::session::get_session(&redis, &jti)
        .await
        .ok()
        .flatten()
        .is_some();

    tracing::debug!("ws_upgrade: session check result: exists={session_exists}");

    if !session_exists {
        return ws
            .on_upgrade(|mut socket| async move {
                let _ = socket
                    .send(axum::extract::ws::Message::Close(Some(CloseFrame {
                        code: close_codes::INVALID_TOKEN,
                        reason: "session expired or revoked".into(),
                    })))
                    .await;
            })
            .into_response();
    }

    // Valid token — proceed with WebSocket upgrade
    tracing::debug!("ws_upgrade: upgrading connection for user sub={}", claims.sub);
    ws.on_upgrade(move |socket| connection::handle_connection(state, socket, claims))
        .into_response()
}
