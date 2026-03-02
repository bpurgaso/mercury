use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderValue, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use fred::prelude::*;
use serde_json::json;
use std::net::SocketAddr;
use std::time::Instant;

use crate::state::AppState;

/// Sliding window rate limiter using Redis sorted sets.
///
/// For each (IP, endpoint) pair, we maintain a sorted set where:
/// - Members are unique request IDs (microsecond timestamps)
/// - Scores are the request timestamps
///
/// On each request:
/// 1. Remove entries older than the window
/// 2. Count remaining entries
/// 3. If under limit, add the new entry
/// 4. Return whether the request is allowed
pub async fn rate_limit_auth(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let ip = addr.ip().to_string();
    let key = format!("rate:auth:{ip}");
    let max_requests: u64 = state.auth_rate_limit_per_min;
    let window_seconds: u64 = 60;

    match check_rate_limit(&state.redis, &key, max_requests, window_seconds).await {
        Ok(true) => next.run(request).await,
        Ok(false) => {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [("Retry-After", window_seconds.to_string())],
                axum::Json(json!({ "error": "too many requests" })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!("rate limiter redis error: {e}");
            // Fail open — allow the request if Redis is down
            next.run(request).await
        }
    }
}

/// Check and update the sliding window rate limit.
/// Returns Ok(true) if the request is allowed, Ok(false) if rate limited.
async fn check_rate_limit(
    redis: &RedisClient,
    key: &str,
    max_requests: u64,
    window_seconds: u64,
) -> Result<bool, RedisError> {
    let now_micros = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_micros() as f64;
    let window_micros = (window_seconds as f64) * 1_000_000.0;
    let cutoff = now_micros - window_micros;

    // Remove entries older than the window
    redis
        .zremrangebyscore::<i64, _, _, _>(key, f64::NEG_INFINITY, cutoff)
        .await?;

    // Count entries in the current window
    let count: u64 = redis.zcard(key).await?;

    if count >= max_requests {
        return Ok(false);
    }

    // Add the new request — use microsecond timestamp as both score and member
    // to ensure uniqueness
    let member = format!("{now_micros}");
    redis
        .zadd::<i64, _, _>(key, None, None, false, false, (now_micros, member))
        .await?;

    // Set/refresh TTL on the key so it auto-cleans up
    redis
        .expire::<bool, _>(key, window_seconds as i64 + 1)
        .await?;

    Ok(true)
}

// ── Request Duration Tracking Middleware ─────────────────────

/// Records the duration of each HTTP request as a Prometheus histogram.
pub async fn track_request_duration(
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let start = Instant::now();

    let response = next.run(request).await;

    let duration = start.elapsed().as_secs_f64();
    let endpoint = normalize_path(&path);

    metrics::histogram!(
        crate::metrics::API_REQUEST_DURATION,
        "method" => method,
        "endpoint" => endpoint,
    )
    .record(duration);

    response
}

/// Replace UUID path segments with `:id` for metric label cardinality control.
fn normalize_path(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            if uuid::Uuid::parse_str(segment).is_ok() {
                ":id"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

// ── Security Headers Middleware ──────────────────────────────

/// Adds security headers to every response.
pub async fn security_headers(
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    // Generate or forward X-Request-Id
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());

    let mut response = next.run(request).await;
    let headers = response.headers_mut();

    headers.insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=63072000; includeSubDomains"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    if let Ok(val) = HeaderValue::from_str(&request_id) {
        headers.insert("x-request-id", val);
    }

    response
}
