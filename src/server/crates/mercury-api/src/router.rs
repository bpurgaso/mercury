use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderValue, Method},
    middleware as axum_middleware,
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use serde::Serialize;
use tower_http::cors::CorsLayer;

use crate::handlers;
use crate::middleware::{rate_limit_auth, security_headers, track_request_duration};
use crate::state::AppState;

pub fn create_router(state: AppState) -> Router {
    // Auth routes — rate limited per IP (5/min)
    let auth_routes = Router::new()
        .route("/register", post(handlers::auth::register))
        .route("/login", post(handlers::auth::login))
        .route("/refresh", post(handlers::auth::refresh))
        .route("/logout", post(handlers::auth::logout))
        .layer(axum_middleware::from_fn_with_state(
            state.clone(),
            rate_limit_auth,
        ));

    // User routes — require authentication
    let user_routes = Router::new().route("/me", get(handlers::users::get_me));

    // Server routes — require authentication
    let server_routes = Router::new()
        .route("/", post(handlers::servers::create_server))
        .route("/", get(handlers::servers::list_servers))
        .route("/join", post(handlers::servers::join_server))
        .route("/{id}", get(handlers::servers::get_server))
        .route("/{id}", patch(handlers::servers::update_server))
        .route("/{id}", delete(handlers::servers::delete_server))
        .route(
            "/{id}/members",
            get(handlers::servers::list_members),
        )
        .route(
            "/{id}/members/me",
            delete(handlers::servers::leave_server),
        )
        .route(
            "/{id}/channels",
            post(handlers::channels::create_channel),
        )
        .route(
            "/{id}/channels",
            get(handlers::channels::list_channels),
        )
        // Moderation routes
        .route("/{id}/bans", post(handlers::moderation::ban_user))
        .route("/{id}/bans", get(handlers::moderation::list_bans))
        .route(
            "/{id}/bans/{user_id}",
            delete(handlers::moderation::unban_user),
        )
        .route(
            "/{id}/kicks/{user_id}",
            post(handlers::moderation::kick_user),
        )
        .route(
            "/{id}/moderators/{user_id}",
            put(handlers::moderation::promote_moderator),
        )
        .route(
            "/{id}/moderators/{user_id}",
            delete(handlers::moderation::demote_moderator),
        )
        .route(
            "/{id}/audit-log",
            get(handlers::moderation::get_audit_log),
        )
        .route(
            "/{id}/reports",
            get(handlers::moderation::list_reports),
        )
        .route(
            "/{id}/moderation-key",
            get(handlers::moderation::get_moderation_key),
        );

    // Device routes — require authentication
    let device_routes = Router::new()
        .route("/", post(handlers::devices::create_device))
        .route("/", get(handlers::devices::list_devices))
        .route("/{id}", delete(handlers::devices::delete_device))
        .route("/{id}/keys", put(handlers::devices::upload_keys));

    // Channel routes (not nested under servers — addressed by channel ID directly)
    let channel_routes = Router::new()
        .route("/{id}", patch(handlers::channels::update_channel))
        .route("/{id}", delete(handlers::channels::delete_channel))
        .route(
            "/{id}/messages",
            get(handlers::messages::get_messages),
        )
        .route("/{id}/mutes", post(handlers::moderation::mute_user))
        .route(
            "/{id}/mutes/{user_id}",
            delete(handlers::moderation::unmute_user),
        );

    // Sender key routes — require authentication
    let sender_key_routes = Router::new()
        .route("/pending", get(handlers::sender_keys::get_pending))
        .route(
            "/acknowledge",
            post(handlers::sender_keys::acknowledge),
        );

    // Call routes — require authentication
    let call_routes = Router::new()
        .route("/", post(handlers::calls::create_call))
        .route("/{id}", get(handlers::calls::get_call));

    // DM routes — require authentication
    let dm_routes = Router::new()
        .route("/", post(handlers::dm::create_or_get_dm))
        .route("/", get(handlers::dm::list_dm_channels))
        .route("/{id}/messages", get(handlers::dm::get_dm_messages));

    // Report routes — require authentication
    let report_routes = Router::new()
        .route("/", post(handlers::moderation::submit_report))
        .route("/{id}", get(handlers::moderation::get_report))
        .route("/{id}", patch(handlers::moderation::review_report));

    // Admin routes — require authentication (owner/mod of at least one server)
    let admin_routes = Router::new()
        .route(
            "/abuse-signals",
            get(handlers::moderation::list_abuse_signals),
        )
        .route(
            "/abuse-signals/{id}",
            patch(handlers::moderation::mark_signal_reviewed),
        )
        .route(
            "/abuse-stats",
            get(handlers::moderation::get_abuse_stats),
        );

    // Build CORS layer from config
    let cors = build_cors_layer(&state.cors_origins);

    // Combine all routes
    Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics_handler))
        .route("/ws", get(handlers::websocket::ws_upgrade))
        .nest("/auth", auth_routes)
        .nest("/users", user_routes)
        .nest("/servers", server_routes)
        .nest("/devices", device_routes)
        .nest("/channels", channel_routes)
        .nest("/dm", dm_routes)
        .nest("/calls", call_routes)
        .nest("/reports", report_routes)
        .nest("/admin", admin_routes)
        .nest("/sender-keys", sender_key_routes)
        // Key bundle fetch routes nested under /users (any authenticated user can fetch)
        .route(
            "/users/{user_id}/devices/{device_id}/keys",
            get(handlers::devices::fetch_key_bundle),
        )
        .route(
            "/users/{user_id}/keys",
            get(handlers::devices::fetch_all_bundles),
        )
        .route(
            "/users/{user_id}/devices/{device_id}/keys/one-time",
            post(handlers::devices::claim_otp),
        )
        // User block routes
        .route(
            "/users/me/blocks",
            get(handlers::moderation::list_blocks),
        )
        .route(
            "/users/me/blocks/{user_id}",
            put(handlers::moderation::block_user),
        )
        .route(
            "/users/me/blocks/{user_id}",
            delete(handlers::moderation::unblock_user),
        )
        // DM policy route
        .route(
            "/users/me/dm-policy",
            put(handlers::moderation::set_dm_policy),
        )
        // Identity management routes
        .route(
            "/users/me/identity",
            delete(handlers::identity::reset_identity),
        )
        // Device list routes
        .route(
            "/users/me/device-list",
            put(handlers::identity::upload_device_list),
        )
        .route(
            "/users/{user_id}/device-list",
            get(handlers::identity::get_device_list),
        )
        // Key backup routes (private — only the owner can access).
        // Raised body limit (15 MB) to allow backup blobs up to 10 MB after
        // base64 decoding (~13.4 MB encoded + JSON overhead).
        .route(
            "/users/me/key-backup",
            put(handlers::identity::upload_key_backup)
                .get(handlers::identity::get_key_backup)
                .delete(handlers::identity::delete_key_backup)
                .layer(DefaultBodyLimit::max(15 * 1024 * 1024)),
        )
        .layer(cors)
        .layer(axum_middleware::from_fn(security_headers))
        .layer(axum_middleware::from_fn(track_request_duration))
        .with_state(state)
}

/// Build a CORS layer from the configured allowed origins.
fn build_cors_layer(cors_origins: &[String]) -> CorsLayer {
    let methods = [
        Method::GET,
        Method::POST,
        Method::PUT,
        Method::DELETE,
        Method::OPTIONS,
    ];
    let allowed_headers = [
        header::CONTENT_TYPE,
        header::AUTHORIZATION,
        header::HeaderName::from_static("x-request-id"),
    ];

    let layer = CorsLayer::new()
        .allow_methods(methods)
        .allow_headers(allowed_headers)
        .allow_credentials(true);

    if cors_origins.is_empty() {
        // No origins configured — block all cross-origin requests
        layer
    } else {
        let origins: Vec<HeaderValue> = cors_origins
            .iter()
            .filter_map(|o| o.parse().ok())
            .collect();
        layer.allow_origin(origins)
    }
}

// ── Health Check ────────────────────────────────────────────

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    database: String,
    redis: String,
    turn: String,
    version: String,
    uptime_seconds: u64,
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let db_ok = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&state.db),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false);

    let redis_ok = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        fred::prelude::ClientLike::ping::<String>(&state.redis),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false);

    let turn_status = if state.turn_config.enabled {
        // Check TURN reachability via UDP probe
        match check_turn_reachable(&state.turn_config.urls).await {
            true => "ok",
            false => "unreachable",
        }
    } else {
        "disabled"
    };

    let status = if db_ok && redis_ok {
        if turn_status == "unreachable" {
            "degraded"
        } else {
            "ok"
        }
    } else {
        "unhealthy"
    };

    Json(HealthResponse {
        status: status.to_string(),
        database: if db_ok { "ok".to_string() } else { "unreachable".to_string() },
        redis: if redis_ok { "ok".to_string() } else { "unreachable".to_string() },
        turn: turn_status.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_seconds: state.start_time.elapsed().as_secs(),
    })
}

/// Quick UDP probe to check if the TURN server is reachable.
async fn check_turn_reachable(urls: &[String]) -> bool {
    use tokio::net::UdpSocket;

    for url in urls {
        // Parse turn:host:port format
        let addr = url
            .strip_prefix("turn:")
            .or_else(|| url.strip_prefix("turns:"))
            .unwrap_or(url);

        if let Ok(socket) = UdpSocket::bind("0.0.0.0:0").await {
            if socket.connect(addr).await.is_ok() {
                // Send a STUN binding request (first 4 bytes: type=0x0001, length=0x0000)
                let stun_binding = [0x00, 0x01, 0x00, 0x00,
                    0x21, 0x12, 0xa4, 0x42,
                    0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x01];
                let _ = socket.send(&stun_binding).await;

                let mut buf = [0u8; 64];
                match tokio::time::timeout(
                    std::time::Duration::from_millis(500),
                    socket.recv(&mut buf),
                ).await {
                    Ok(Ok(_)) => return true,
                    _ => continue,
                }
            }
        }
    }
    false
}

// ── Metrics Handler ─────────────────────────────────────────

async fn metrics_handler(
    State(state): State<AppState>,
) -> ([(header::HeaderName, HeaderValue); 1], String) {
    // Compute DB pool stats on-demand
    let pool_size = state.db.size() as f64;
    let idle = state.db.num_idle() as f64;
    let active = pool_size - idle;

    metrics::gauge!(crate::metrics::DB_POOL_CONNECTIONS, "state" => "active").set(active);
    metrics::gauge!(crate::metrics::DB_POOL_CONNECTIONS, "state" => "idle").set(idle);

    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
        )],
        state.metrics_handle.render(),
    )
}
