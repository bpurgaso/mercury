use axum::{extract::State, Json};
use mercury_core::error::MercuryError;
use mercury_db::users;
use serde::Serialize;

use crate::extractors::AuthUser;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct UserResponse {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub email: String,
    pub avatar_url: Option<String>,
    pub status: Option<String>,
    pub created_at: Option<String>,
}

/// GET /users/me — Return the authenticated user's profile.
pub async fn get_me(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<UserResponse>, MercuryError> {
    let user = users::get_user_by_id(&state.db, auth_user.user_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("user not found".into()))?;

    Ok(Json(UserResponse {
        id: user.id.0.to_string(),
        username: user.username,
        display_name: user.display_name,
        email: user.email,
        avatar_url: user.avatar_url,
        status: user.status,
        created_at: user.created_at.map(|t| t.to_rfc3339()),
    }))
}
