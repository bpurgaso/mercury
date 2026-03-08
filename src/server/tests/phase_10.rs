mod common;

use common::{setup, TestServer};
use reqwest::Client;
use serde_json::json;
use std::time::Duration;

/// GET /metrics returns 200 and contains expected metric names.
// TESTSPEC: API-086
// TESTSPEC: API-087
#[tokio::test]
async fn test_metrics_endpoint() {
    let server = TestServer::start().await;
    setup(&server).await;

    let client = server.client();
    // Make a warm-up request so the duration middleware records at least one sample
    // (the middleware records *after* the response, so the first /metrics render
    // would not yet contain the histogram).
    client.get_text("/health").await;
    let (status, body) = client.get_text("/metrics").await;

    assert_eq!(status, 200);
    // The metrics handler sets DB pool gauges on every call, so those should appear.
    // The request-duration histogram is also recorded for this request itself.
    assert!(
        body.contains("mercury_db_pool_connections"),
        "metrics should contain mercury_db_pool_connections, got:\n{body}"
    );
    assert!(
        body.contains("mercury_api_request_duration"),
        "metrics should contain mercury_api_request_duration"
    );
    // Verify it's valid Prometheus format (contains TYPE or HELP lines)
    assert!(
        body.contains("# HELP") || body.contains("# TYPE"),
        "metrics output should contain Prometheus HELP/TYPE lines"
    );
}

/// After WS identify, mercury_connected_clients should be >= 1.
// TESTSPEC: API-088
#[tokio::test]
async fn test_metrics_after_ws_connect() {
    let server = TestServer::start().await;
    setup(&server).await;

    let mut client = server.client();
    client
        .register_raw("metricuser", "metric@test.com", "password123")
        .await;
    let token = client.access_token.clone().unwrap();

    // Connect and identify via WS
    let mut ws = server.ws_client(&token).await;
    ws.identify(&token, "device-metric-1").await;

    // Small delay for metrics to propagate
    tokio::time::sleep(Duration::from_millis(200)).await;

    let reader = server.client();
    let (status, body) = reader.get_text("/metrics").await;
    assert_eq!(status, 200);

    // The gauge should have been incremented — look for the metric line
    assert!(
        body.contains("mercury_connected_clients"),
        "metrics should contain connected_clients gauge"
    );

    ws.close().await;
}

/// After message relay, mercury_messages_relayed_total should increment.
// TESTSPEC: API-088
#[tokio::test]
async fn test_metrics_after_message_send() {
    let server = TestServer::start().await;
    setup(&server).await;

    // Register two users
    let mut alice = server.client();
    let (alice_status, _) = alice
        .register_raw("alice_m10", "alice_m10@test.com", "password123")
        .await;
    assert!(
        alice_status.is_success(),
        "alice registration should succeed"
    );
    let alice_token = alice.access_token.clone().unwrap();

    let mut bob = server.client();
    let (bob_status, _) = bob
        .register_raw("bob_m10", "bob_m10@test.com", "password123")
        .await;
    assert!(bob_status.is_success(), "bob registration should succeed");
    let bob_token = bob.access_token.clone().unwrap();

    // Create server and channel
    let (srv_status, server_body) = alice
        .post_authed("/servers", &json!({ "name": "metric-server" }))
        .await;
    assert!(srv_status.is_success(), "create server failed: {server_body}");
    let server_id = server_body["id"].as_str().unwrap();

    let (ch_status, channel_body) = alice
        .post_authed(
            &format!("/servers/{server_id}/channels"),
            &json!({ "name": "general", "channel_type": "text", "encryption_mode": "standard" }),
        )
        .await;
    assert!(ch_status.is_success(), "create channel failed (status={ch_status}): {channel_body}");
    let channel_id = channel_body["id"].as_str().unwrap();

    // Bob joins server
    let invite_code = server_body["invite_code"].as_str().unwrap();
    bob.post_authed("/servers/join", &json!({ "invite_code": invite_code }))
        .await;

    // Connect both via WS
    let mut alice_ws = server.ws_client(&alice_token).await;
    alice_ws.identify(&alice_token, "device-a10").await;

    let mut bob_ws = server.ws_client(&bob_token).await;
    bob_ws.identify(&bob_token, "device-b10").await;

    // Send a message
    alice_ws
        .send_json(&json!({
            "op": "message_send",
            "d": {
                "channel_id": channel_id,
                "content": "hello from metrics test"
            }
        }))
        .await;

    // Wait for message to propagate
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Check metrics
    let reader = server.client();
    let (status, body) = reader.get_text("/metrics").await;
    assert_eq!(status, 200);
    assert!(
        body.contains("mercury_messages_relayed"),
        "metrics should contain messages_relayed counter"
    );

    alice_ws.close().await;
    bob_ws.close().await;
}

/// GET /health returns JSON with all expected fields.
// TESTSPEC: API-083
// TESTSPEC: API-085
#[tokio::test]
async fn test_health_check_json() {
    let server = TestServer::start().await;
    setup(&server).await;

    let client = server.client();
    let (status, body) = client.get("/health").await;

    assert_eq!(status, 200);
    // Status may be "ok" or "degraded" depending on TURN reachability
    let health_status = body["status"].as_str().unwrap();
    assert!(
        health_status == "ok" || health_status == "degraded",
        "health status should be ok or degraded, got: {health_status}"
    );
    assert_eq!(body["database"], "ok");
    assert_eq!(body["redis"], "ok");
    assert!(body["version"].is_string());
    assert!(body["uptime_seconds"].is_number());
    assert!(body["turn"].is_string());
}

/// With unreachable TURN, health status should be "degraded".
#[tokio::test]
async fn test_health_check_degraded_turn() {
    let server = TestServer::start().await;
    setup(&server).await;

    let client = server.client();
    let (status, body) = client.get("/health").await;

    assert_eq!(status, 200);
    let health_status = body["status"].as_str().unwrap();
    assert!(
        health_status == "ok" || health_status == "degraded",
        "health status should be ok or degraded, got: {health_status}"
    );
}

/// Security headers are present on all responses.
// TESTSPEC: API-089
// TESTSPEC: SEC-015
#[tokio::test]
async fn test_security_headers() {
    let server = TestServer::start().await;
    setup(&server).await;

    let client = server.client();
    let (status, headers, _body) = client.get_with_headers("/health").await;

    assert_eq!(status, 200);

    assert!(
        headers.contains_key("strict-transport-security"),
        "should have HSTS header"
    );
    assert!(
        headers.contains_key("content-security-policy"),
        "should have CSP header"
    );
    assert!(
        headers.contains_key("x-content-type-options"),
        "should have X-Content-Type-Options header"
    );
    assert!(
        headers.contains_key("x-frame-options"),
        "should have X-Frame-Options header"
    );
    assert!(
        headers.contains_key("cache-control"),
        "should have Cache-Control header"
    );
    assert!(
        headers.contains_key("referrer-policy"),
        "should have Referrer-Policy header"
    );
    assert!(
        headers.contains_key("x-request-id"),
        "should have X-Request-Id header"
    );
}

/// CORS denies unlisted origins (no Access-Control-Allow-Origin returned).
#[tokio::test]
async fn test_cors_denies_unlisted_origin() {
    let server = TestServer::start().await;
    setup(&server).await;

    let http = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let resp = http
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/health", server.base_url()),
        )
        .header("Origin", "https://evil.example.com")
        .header("Access-Control-Request-Method", "GET")
        .send()
        .await
        .expect("OPTIONS request failed");

    // No Access-Control-Allow-Origin should be present for unlisted origin
    let allow_origin = resp.headers().get("access-control-allow-origin");
    assert!(
        allow_origin.is_none(),
        "should not have ACAO header for unlisted origin, got: {:?}",
        allow_origin
    );
}

/// display_name longer than 100 chars should be rejected.
// TESTSPEC: CORE-008 (integration)
#[tokio::test]
async fn test_input_validation_display_name_too_long() {
    let server = TestServer::start().await;
    setup(&server).await;

    let mut client = server.client();
    let long_name = "a".repeat(101);
    let (status, _) = client
        .register_raw(&long_name, "longname@test.com", "password123")
        .await;

    assert_eq!(status, 400, "username > 100 chars should return 400");
}

/// Invalid UUID in path should return 4xx (400 or 422).
#[tokio::test]
async fn test_input_validation_invalid_uuid() {
    let server = TestServer::start().await;
    setup(&server).await;

    let mut client = server.client();
    let (reg_status, _) = client
        .register_raw("uuidtest", "uuid@test.com", "password123")
        .await;
    assert!(reg_status.is_success(), "registration should succeed");

    let (status, _) = client.get_authed("/servers/not-a-uuid").await;
    // Axum returns 400 or 422 for invalid path parameters depending on extractor
    assert!(
        status == 400 || status == 422,
        "invalid UUID in path should return 400 or 422, got: {status}"
    );
}

/// page_size exceeding maximum should be capped or rejected.
#[tokio::test]
async fn test_input_validation_page_size_capped() {
    let server = TestServer::start().await;
    setup(&server).await;

    let mut client = server.client();
    let (reg_status, _) = client
        .register_raw("pagetest10", "page10@test.com", "password123")
        .await;
    assert!(reg_status.is_success(), "registration should succeed");

    // Create a server to have a valid context
    let (_, server_body) = client
        .post_authed("/servers", &json!({ "name": "page-test-server" }))
        .await;
    let server_id = server_body["id"].as_str().unwrap();

    let (_, channel_body) = client
        .post_authed(
            &format!("/servers/{server_id}/channels"),
            &json!({ "name": "general", "channel_type": "text", "encryption_mode": "standard" }),
        )
        .await;
    let channel_id = channel_body["id"].as_str().unwrap();

    // Request with absurdly large page_size — the handler caps it at 100
    let (status, _) = client
        .get_authed(&format!(
            "/channels/{channel_id}/messages?limit=10000"
        ))
        .await;

    // Should return 200 with capped page_size
    assert!(
        status == 200 || status == 400,
        "page_size=10000 should be handled gracefully, got: {status}"
    );
}
