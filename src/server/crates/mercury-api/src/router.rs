use axum::{
    extract::DefaultBodyLimit,
    http::Method,
    middleware as axum_middleware,
    routing::{delete, get, patch, post, put},
    Router,
};
use tower_http::cors::{Any, CorsLayer};

use crate::handlers;
use crate::middleware::rate_limit_auth;
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

    let cors = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any)
        .allow_origin(Any);

    // Combine all routes
    Router::new()
        .route("/health", get(health))
        .route("/ws", get(handlers::websocket::ws_upgrade))
        .nest("/auth", auth_routes)
        .nest("/users", user_routes)
        .nest("/servers", server_routes)
        .nest("/devices", device_routes)
        .nest("/channels", channel_routes)
        .nest("/dm", dm_routes)
        .nest("/calls", call_routes)
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
        .with_state(state)
}

async fn health() -> &'static str {
    "OK"
}
