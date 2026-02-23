use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use mercury_auth::{jwt, password, session};
use mercury_core::error::MercuryError;
use mercury_core::ids::UserId;
use mercury_db::users;
use serde::{Deserialize, Serialize};

use crate::extractors::AuthUser;
use crate::state::AppState;

// ── Request/Response types ────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub user_id: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

// ── Handlers ──────────────────────────────────────────────

/// POST /auth/register — Create a new account and return tokens.
pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> Result<impl IntoResponse, MercuryError> {
    validate_registration(&body)?;

    // Check for existing username
    if users::get_user_by_username(&state.db, &body.username)
        .await?
        .is_some()
    {
        return Err(MercuryError::Conflict("username already taken".into()));
    }

    // Check for existing email
    if users::get_user_by_email(&state.db, &body.email)
        .await?
        .is_some()
    {
        return Err(MercuryError::Conflict("email already registered".into()));
    }

    // Hash password on a blocking thread to avoid stalling the async runtime
    let auth_config = state.auth_config.clone();
    let password_input = body.password.clone();
    let password_hash = tokio::task::spawn_blocking(move || {
        password::hash_password(&auth_config, &password_input)
    })
    .await
    .map_err(|e| MercuryError::Internal(anyhow::anyhow!("task join error: {e}")))?
    .map_err(|e| MercuryError::Internal(anyhow::anyhow!("password hashing failed: {e}")))?;

    // Create user
    let user_id = UserId::new();
    users::create_user(
        &state.db,
        user_id,
        &body.username,
        &body.username, // display_name defaults to username
        &body.email,
        &password_hash,
    )
    .await?;

    // Generate tokens and store sessions
    let response = create_tokens_and_sessions(&state, user_id).await?;
    Ok((StatusCode::CREATED, Json(response)))
}

/// POST /auth/login — Authenticate and return tokens.
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<impl IntoResponse, MercuryError> {
    // Look up user by email
    let user = users::get_user_by_email(&state.db, &body.email)
        .await?
        .ok_or_else(|| MercuryError::Unauthorized("invalid email or password".into()))?;

    // Verify password on a blocking thread
    let auth_config = state.auth_config.clone();
    let password_input = body.password.clone();
    let stored_hash = user.password_hash.clone();
    let valid = tokio::task::spawn_blocking(move || {
        password::verify_password(&auth_config, &password_input, &stored_hash)
    })
    .await
    .map_err(|e| MercuryError::Internal(anyhow::anyhow!("task join error: {e}")))?
    .map_err(|e| MercuryError::Internal(anyhow::anyhow!("password verification failed: {e}")))?;

    if !valid {
        return Err(MercuryError::Unauthorized("invalid email or password".into()));
    }

    let response = create_tokens_and_sessions(&state, user.id).await?;
    Ok((StatusCode::OK, Json(response)))
}

/// POST /auth/refresh — Exchange a refresh token for new access + refresh tokens.
pub async fn refresh(
    State(state): State<AppState>,
    Json(body): Json<RefreshRequest>,
) -> Result<impl IntoResponse, MercuryError> {
    let token_data = jwt::validate_token(&state.auth_config, &body.refresh_token)
        .map_err(|_| MercuryError::Unauthorized("invalid or expired refresh token".into()))?;

    if token_data.claims.token_type != "refresh" {
        return Err(MercuryError::Unauthorized("expected refresh token".into()));
    }

    // Verify session exists in Redis (not revoked)
    session::get_session(&state.redis, &token_data.claims.jti)
        .await
        .map_err(|e| MercuryError::Internal(anyhow::anyhow!("redis error: {e}")))?
        .ok_or_else(|| MercuryError::Unauthorized("refresh token revoked".into()))?;

    let user_id = jwt::user_id_from_claims(&token_data.claims)
        .map_err(|_| MercuryError::Unauthorized("invalid user ID in token".into()))?;

    // Revoke the old refresh token (single use)
    session::delete_session(&state.redis, &token_data.claims.jti)
        .await
        .map_err(|e| MercuryError::Internal(anyhow::anyhow!("redis error: {e}")))?;

    let response = create_tokens_and_sessions(&state, user_id).await?;
    Ok((StatusCode::OK, Json(response)))
}

/// POST /auth/logout — Invalidate the current session and its paired refresh token.
pub async fn logout(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<impl IntoResponse, MercuryError> {
    // Read the access session to find the paired refresh token JTI
    let session_data = session::get_session(&state.redis, &auth_user.jti)
        .await
        .map_err(|e| MercuryError::Internal(anyhow::anyhow!("redis error: {e}")))?;

    // Delete the access token session
    session::delete_session(&state.redis, &auth_user.jti)
        .await
        .map_err(|e| MercuryError::Internal(anyhow::anyhow!("redis error: {e}")))?;

    // Also revoke the paired refresh token session
    if let Some(data) = session_data {
        if let Some(refresh_jti) = data.paired_refresh_jti {
            session::delete_session(&state.redis, &refresh_jti)
                .await
                .map_err(|e| MercuryError::Internal(anyhow::anyhow!("redis error: {e}")))?;
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

// ── Helpers ───────────────────────────────────────────────

/// Generate a token pair and store both sessions in Redis.
async fn create_tokens_and_sessions(
    state: &AppState,
    user_id: UserId,
) -> Result<AuthResponse, MercuryError> {
    let token_pair = jwt::create_token_pair(&state.auth_config, user_id)
        .map_err(|e| MercuryError::Internal(anyhow::anyhow!("token generation failed: {e}")))?;

    let access_ttl = state.auth_config.jwt_expiry_minutes * 60;
    let refresh_ttl = state.auth_config.refresh_token_expiry_days * 86400;

    // Store access session with a reference to the paired refresh JTI
    // so logout can revoke both tokens
    session::create_session_with_refresh_jti(
        &state.redis,
        &token_pair.access_token_jti,
        user_id,
        token_pair.access_token_exp,
        access_ttl,
        &token_pair.refresh_token_jti,
    )
    .await
    .map_err(|e| MercuryError::Internal(anyhow::anyhow!("redis error: {e}")))?;

    session::create_session(
        &state.redis,
        &token_pair.refresh_token_jti,
        user_id,
        token_pair.refresh_token_exp,
        refresh_ttl,
    )
    .await
    .map_err(|e| MercuryError::Internal(anyhow::anyhow!("redis error: {e}")))?;

    Ok(AuthResponse {
        user_id: user_id.0.to_string(),
        access_token: token_pair.access_token,
        refresh_token: token_pair.refresh_token,
        expires_in: token_pair.expires_in,
    })
}

// ── Validation ────────────────────────────────────────────

fn validate_registration(body: &RegisterRequest) -> Result<(), MercuryError> {
    if body.username.len() < 3 || body.username.len() > 32 {
        return Err(MercuryError::BadRequest(
            "username must be 3-32 characters".into(),
        ));
    }

    if !body
        .username
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        return Err(MercuryError::BadRequest(
            "username must contain only alphanumeric characters, underscores, or hyphens".into(),
        ));
    }

    if body.email.is_empty() || !body.email.contains('@') {
        return Err(MercuryError::BadRequest("invalid email address".into()));
    }

    if body.password.len() < 8 {
        return Err(MercuryError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }

    Ok(())
}
