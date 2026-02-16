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
