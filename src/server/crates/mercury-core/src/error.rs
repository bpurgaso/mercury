use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MercuryError {
    #[error("internal server error")]
    Internal(#[from] anyhow::Error),

    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("unauthorized: {0}")]
    Unauthorized(String),

    #[error("forbidden: {0}")]
    Forbidden(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("rate limited")]
    RateLimited { retry_after: u64 },
}

impl IntoResponse for MercuryError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            MercuryError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, self.to_string()),
            MercuryError::Database(_) => {
                tracing::error!("database error: {self}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal server error".to_string(),
                )
            }
            MercuryError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            MercuryError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg.clone()),
            MercuryError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            MercuryError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone()),
            MercuryError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            MercuryError::RateLimited { retry_after } => {
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    [("Retry-After", retry_after.to_string())],
                    axum::Json(json!({ "error": "too many requests" })),
                )
                    .into_response();
            }
        };

        (status, axum::Json(json!({ "error": message }))).into_response()
    }
}
