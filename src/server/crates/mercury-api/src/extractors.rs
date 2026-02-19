use axum::{
    extract::FromRequestParts,
    http::request::Parts,
};
use mercury_auth::jwt;
use mercury_core::{error::MercuryError, ids::UserId};

use crate::state::AppState;

/// Extractor that validates the JWT from the Authorization header and provides
/// the authenticated user's ID and JWT ID (jti) to handlers.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: UserId,
    pub jti: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = MercuryError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // Extract token from Authorization: Bearer <token>
        let auth_header = parts
            .headers
            .get("Authorization")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| MercuryError::Unauthorized("missing authorization header".into()))?;

        let token = auth_header
            .strip_prefix("Bearer ")
            .ok_or_else(|| MercuryError::Unauthorized("invalid authorization header format".into()))?;

        // Validate JWT
        let token_data = jwt::validate_token(&state.auth_config, token)
            .map_err(|_| MercuryError::Unauthorized("invalid or expired token".into()))?;

        // Ensure it's an access token
        if token_data.claims.token_type != "access" {
            return Err(MercuryError::Unauthorized(
                "expected access token".into(),
            ));
        }

        // Verify session exists in Redis (token not revoked)
        let session = mercury_auth::session::get_session(&state.redis, &token_data.claims.jti)
            .await
            .map_err(|e| MercuryError::Internal(anyhow::anyhow!("redis error: {e}")))?;

        if session.is_none() {
            return Err(MercuryError::Unauthorized("session expired or revoked".into()));
        }

        let user_id = jwt::user_id_from_claims(&token_data.claims)
            .map_err(|_| MercuryError::Unauthorized("invalid user ID in token".into()))?;

        Ok(AuthUser {
            user_id,
            jti: token_data.claims.jti,
        })
    }
}

/// Check that a user is a member of the given server. Returns 403 if not.
pub async fn require_membership(
    state: &AppState,
    user_id: UserId,
    server_id: mercury_core::ids::ServerId,
) -> Result<(), MercuryError> {
    let is_member = mercury_db::servers::is_member(&state.db, user_id, server_id)
        .await
        .map_err(|e| MercuryError::Database(e))?;
    if !is_member {
        return Err(MercuryError::Forbidden("not a member of this server".into()));
    }
    Ok(())
}

/// Check that a user is the owner of the given server. Returns 403 if not.
pub async fn require_ownership(
    state: &AppState,
    user_id: UserId,
    server_id: mercury_core::ids::ServerId,
) -> Result<(), MercuryError> {
    let server = mercury_db::servers::get_server_by_id(&state.db, server_id)
        .await
        .map_err(|e| MercuryError::Database(e))?
        .ok_or_else(|| MercuryError::NotFound("server not found".into()))?;
    if server.owner_id != user_id {
        return Err(MercuryError::Forbidden("not the server owner".into()));
    }
    Ok(())
}
