use axum::{
    middleware as axum_middleware,
    routing::{get, post},
    Router,
};

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

    // Combine all routes
    Router::new()
        .route("/health", get(health))
        .route("/ws", get(handlers::websocket::ws_upgrade))
        .nest("/auth", auth_routes)
        .nest("/users", user_routes)
        .with_state(state)
}

async fn health() -> &'static str {
    "OK"
}
