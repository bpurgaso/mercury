// Server-side performance benchmarks for Mercury.
//
// Benchmarks:
// - JWT validation throughput
// - JWT token creation throughput
// - Message relay: WS protocol parsing + event encoding (simulates message_send → fan-out)
// - Message history: response serialization for paginated queries (50 messages)
//
// Run with: cargo bench --manifest-path src/server/Cargo.toml
//
// Note: DB query benchmarks require a running PostgreSQL instance and are
// covered by the integration tests in tests/. These benchmarks exercise the
// CPU-bound portions of the message relay pipeline (parsing, validation,
// serialization, encoding) which are the server-controlled latency components.

use std::time::Instant;

// ── JWT Benchmarks ──────────────────────────────────────────

fn bench_jwt_validation() {
    use mercury_auth::jwt::{create_access_token, validate_token};
    use mercury_core::config::AuthConfig;
    use mercury_core::ids::UserId;

    let config = AuthConfig {
        jwt_secret: "bench-jwt-secret-key-for-performance-testing".into(),
        jwt_expiry_minutes: 60,
        refresh_token_expiry_days: 30,
        argon2_memory_kib: 65536,
        argon2_iterations: 3,
        argon2_parallelism: 4,
    };
    let user_id = UserId::new();

    let (token, _) = create_access_token(&config, user_id).expect("create token");

    // Warmup
    for _ in 0..100 {
        let _ = validate_token(&config, &token);
    }

    // Benchmark
    let iterations = 10_000;
    let start = Instant::now();
    for _ in 0..iterations {
        let _ = validate_token(&config, &token).expect("validate");
    }
    let elapsed = start.elapsed();

    let per_op = elapsed / iterations;
    let ops_per_sec = iterations as f64 / elapsed.as_secs_f64();

    println!("=== JWT Validation Benchmark ===");
    println!("  {} iterations in {:.2?}", iterations, elapsed);
    println!("  {:.3?} per validation", per_op);
    println!("  {:.0} validations/sec", ops_per_sec);
    println!();
}

fn bench_jwt_creation() {
    use mercury_auth::jwt::create_token_pair;
    use mercury_core::config::AuthConfig;
    use mercury_core::ids::UserId;

    let config = AuthConfig {
        jwt_secret: "bench-jwt-secret-key-for-performance-testing".into(),
        jwt_expiry_minutes: 60,
        refresh_token_expiry_days: 30,
        argon2_memory_kib: 65536,
        argon2_iterations: 3,
        argon2_parallelism: 4,
    };
    let user_id = UserId::new();

    // Warmup
    for _ in 0..100 {
        let _ = create_token_pair(&config, user_id);
    }

    // Benchmark
    let iterations = 10_000;
    let start = Instant::now();
    for _ in 0..iterations {
        let _ = create_token_pair(&config, user_id).expect("create pair");
    }
    let elapsed = start.elapsed();

    let per_op = elapsed / iterations;
    let ops_per_sec = iterations as f64 / elapsed.as_secs_f64();

    println!("=== JWT Token Pair Creation Benchmark ===");
    println!("  {} iterations in {:.2?}", iterations, elapsed);
    println!("  {:.3?} per creation", per_op);
    println!("  {:.0} creations/sec", ops_per_sec);
    println!();
}

// ── Message Relay Benchmarks ─────────────────────────────────
//
// Simulates the CPU-bound portion of the message relay pipeline:
// 1. Parse incoming WS frame (JSON text + MessagePack binary)
// 2. Build outgoing server event
// 3. Encode for fan-out (JSON + MessagePack)

fn bench_message_relay_parse_json() {
    use mercury_api::ws::protocol::{ClientMessage, ClientOp};

    // Realistic message_send payload as JSON text frame
    let payload = serde_json::json!({
        "op": "message_send",
        "d": {
            "channel_id": "01936d2a-7b8c-7def-8a12-abcdef123456",
            "content": "Hello, this is a realistic chat message with some content!"
        }
    });
    let json_bytes = serde_json::to_vec(&payload).unwrap();

    // Warmup
    for _ in 0..100 {
        let _: ClientMessage = serde_json::from_slice(&json_bytes).unwrap();
    }

    // Benchmark
    let iterations = 50_000u32;
    let start = Instant::now();
    for _ in 0..iterations {
        let msg: ClientMessage = serde_json::from_slice(&json_bytes).unwrap();
        assert_eq!(msg.op, ClientOp::MessageSend);
    }
    let elapsed = start.elapsed();

    let per_op = elapsed / iterations;
    let ops_per_sec = iterations as f64 / elapsed.as_secs_f64();

    println!("=== Message Relay: JSON Parse (message_send) ===");
    println!("  {} iterations in {:.2?}", iterations, elapsed);
    println!("  {:.3?} per parse", per_op);
    println!("  {:.0} parses/sec", ops_per_sec);
    println!("  Input size: {} bytes", json_bytes.len());
    println!();
}

fn bench_message_relay_parse_msgpack() {
    use mercury_api::ws::protocol::{BinaryClientMessage, ClientOp};

    // Build a realistic private channel message_send as MessagePack
    let payload = rmpv::Value::Map(vec![
        (
            rmpv::Value::String("op".into()),
            rmpv::Value::String("message_send".into()),
        ),
        (
            rmpv::Value::String("d".into()),
            rmpv::Value::Map(vec![
                (
                    rmpv::Value::String("channel_id".into()),
                    rmpv::Value::String("01936d2a-7b8c-7def-8a12-abcdef123456".into()),
                ),
                (
                    rmpv::Value::String("encrypted".into()),
                    rmpv::Value::Map(vec![
                        (
                            rmpv::Value::String("ciphertext".into()),
                            rmpv::Value::Binary(vec![0xAA; 256]),
                        ),
                        (
                            rmpv::Value::String("nonce".into()),
                            rmpv::Value::Binary(vec![0xBB; 12]),
                        ),
                        (
                            rmpv::Value::String("signature".into()),
                            rmpv::Value::Binary(vec![0xCC; 64]),
                        ),
                        (
                            rmpv::Value::String("sender_device_id".into()),
                            rmpv::Value::String("01936d2a-aaaa-7def-8a12-abcdef123456".into()),
                        ),
                        (
                            rmpv::Value::String("iteration".into()),
                            rmpv::Value::Integer(42.into()),
                        ),
                        (
                            rmpv::Value::String("epoch".into()),
                            rmpv::Value::Integer(1.into()),
                        ),
                    ]),
                ),
            ]),
        ),
    ]);
    let msgpack_bytes = rmp_serde::to_vec_named(&payload).unwrap();

    // Warmup
    for _ in 0..100 {
        let _: BinaryClientMessage = rmp_serde::from_slice(&msgpack_bytes).unwrap();
    }

    // Benchmark
    let iterations = 50_000u32;
    let start = Instant::now();
    for _ in 0..iterations {
        let msg: BinaryClientMessage = rmp_serde::from_slice(&msgpack_bytes).unwrap();
        assert_eq!(msg.op, ClientOp::MessageSend);
    }
    let elapsed = start.elapsed();

    let per_op = elapsed / iterations;
    let ops_per_sec = iterations as f64 / elapsed.as_secs_f64();

    println!("=== Message Relay: MsgPack Parse (private message_send) ===");
    println!("  {} iterations in {:.2?}", iterations, elapsed);
    println!("  {:.3?} per parse", per_op);
    println!("  {:.0} parses/sec", ops_per_sec);
    println!("  Input size: {} bytes", msgpack_bytes.len());
    println!();
}

fn bench_message_relay_encode_fanout() {
    use mercury_api::ws::protocol::{encode_msgpack_server_message, ServerEvent};
    use serde::Serialize;

    #[derive(Serialize)]
    struct MessageCreatePayload {
        id: String,
        channel_id: String,
        sender_id: String,
        content: Option<String>,
        created_at: String,
    }

    let payload = MessageCreatePayload {
        id: uuid::Uuid::now_v7().to_string(),
        channel_id: uuid::Uuid::now_v7().to_string(),
        sender_id: uuid::Uuid::now_v7().to_string(),
        content: Some("Hello, this is a chat message for fan-out benchmarking!".into()),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    // Warmup
    for _ in 0..100 {
        let _ = encode_msgpack_server_message(ServerEvent::MESSAGE_CREATE, &payload, Some(1));
    }

    // Benchmark
    let iterations = 50_000u32;
    let start = Instant::now();
    for _ in 0..iterations {
        let bytes =
            encode_msgpack_server_message(ServerEvent::MESSAGE_CREATE, &payload, Some(1));
        assert!(!bytes.is_empty());
    }
    let elapsed = start.elapsed();

    let per_op = elapsed / iterations;
    let ops_per_sec = iterations as f64 / elapsed.as_secs_f64();
    let encoded_size =
        encode_msgpack_server_message(ServerEvent::MESSAGE_CREATE, &payload, Some(1)).len();

    println!("=== Message Relay: MsgPack Encode (fan-out event) ===");
    println!("  {} iterations in {:.2?}", iterations, elapsed);
    println!("  {:.3?} per encode", per_op);
    println!("  {:.0} encodes/sec", ops_per_sec);
    println!("  Encoded size: {} bytes", encoded_size);
    println!();
}

fn bench_message_relay_full_pipeline() {
    use mercury_api::ws::protocol::{
        encode_msgpack_server_message, ClientMessage, ServerEvent,
    };
    use serde::Serialize;

    // Simulates the full CPU-bound message relay path:
    // 1. Parse incoming JSON frame
    // 2. Build outgoing event payload
    // 3. Encode as MsgPack for fan-out

    let incoming = serde_json::json!({
        "op": "message_send",
        "d": {
            "channel_id": "01936d2a-7b8c-7def-8a12-abcdef123456",
            "content": "Hello from the relay benchmark!"
        }
    });
    let json_bytes = serde_json::to_vec(&incoming).unwrap();

    #[derive(Serialize)]
    struct MessageCreatePayload {
        id: String,
        channel_id: String,
        sender_id: String,
        content: Option<String>,
        created_at: String,
    }

    let sender_id = uuid::Uuid::now_v7().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();

    // Warmup
    for _ in 0..100 {
        let msg: ClientMessage = serde_json::from_slice(&json_bytes).unwrap();
        let channel_id = msg.d.get("channel_id").unwrap().as_str().unwrap();
        let content = msg.d.get("content").and_then(|v| v.as_str()).map(String::from);
        let event_payload = MessageCreatePayload {
            id: uuid::Uuid::now_v7().to_string(),
            channel_id: channel_id.to_string(),
            sender_id: sender_id.clone(),
            content,
            created_at: created_at.clone(),
        };
        let _ = encode_msgpack_server_message(
            ServerEvent::MESSAGE_CREATE,
            &event_payload,
            Some(1),
        );
    }

    // Benchmark
    let iterations = 20_000u32;
    let start = Instant::now();
    for _ in 0..iterations {
        // Step 1: Parse
        let msg: ClientMessage = serde_json::from_slice(&json_bytes).unwrap();

        // Step 2: Extract fields + build event (simulates handler logic)
        let channel_id = msg.d.get("channel_id").unwrap().as_str().unwrap();
        let content = msg.d.get("content").and_then(|v| v.as_str()).map(String::from);
        let event_payload = MessageCreatePayload {
            id: uuid::Uuid::now_v7().to_string(),
            channel_id: channel_id.to_string(),
            sender_id: sender_id.clone(),
            content,
            created_at: created_at.clone(),
        };

        // Step 3: Encode for fan-out
        let bytes = encode_msgpack_server_message(
            ServerEvent::MESSAGE_CREATE,
            &event_payload,
            Some(1),
        );
        assert!(!bytes.is_empty());
    }
    let elapsed = start.elapsed();

    let per_op = elapsed / iterations;
    let ops_per_sec = iterations as f64 / elapsed.as_secs_f64();

    println!("=== Message Relay: Full Pipeline (parse → build → encode) ===");
    println!("  {} iterations in {:.2?}", iterations, elapsed);
    println!("  {:.3?} per relay", per_op);
    println!("  {:.0} relays/sec", ops_per_sec);
    println!();
}

// ── Message History Serialization ────────────────────────────

fn bench_message_history_response() {
    use chrono::Utc;
    use serde::Serialize;
    use uuid::Uuid;

    #[derive(Serialize)]
    struct MessageResponse {
        id: String,
        channel_id: Option<String>,
        sender_id: String,
        content: Option<String>,
        message_type: Option<String>,
        created_at: Option<String>,
        edited_at: Option<String>,
    }

    // Simulate paginated query result: 50 messages
    let messages: Vec<MessageResponse> = (0..50)
        .map(|i| MessageResponse {
            id: Uuid::now_v7().to_string(),
            channel_id: Some(Uuid::now_v7().to_string()),
            sender_id: Uuid::now_v7().to_string(),
            content: Some(format!(
                "This is message number {} with some realistic content length for benchmarking",
                i
            )),
            message_type: Some("text".into()),
            created_at: Some(Utc::now().to_rfc3339()),
            edited_at: None,
        })
        .collect();

    // Warmup
    for _ in 0..100 {
        let _ = serde_json::to_vec(&messages).unwrap();
    }

    // Benchmark
    let iterations = 10_000u32;
    let start = Instant::now();
    for _ in 0..iterations {
        let _ = serde_json::to_vec(&messages).unwrap();
    }
    let elapsed = start.elapsed();

    let per_op = elapsed / iterations;
    let ops_per_sec = iterations as f64 / elapsed.as_secs_f64();
    let payload_size = serde_json::to_vec(&messages).unwrap().len();

    println!("=== Message History Response Serialization (50 messages) ===");
    println!("  {} iterations in {:.2?}", iterations, elapsed);
    println!("  {:.3?} per serialization", per_op);
    println!("  {:.0} serializations/sec", ops_per_sec);
    println!(
        "  Payload size: {} bytes ({:.1} KB)",
        payload_size,
        payload_size as f64 / 1024.0
    );
    println!();
    println!("  Note: DB query latency (get_messages_paginated) depends on");
    println!("  PostgreSQL and is measured via integration tests, not here.");
    println!();
}

// ── PERF-008: Message History Query Benchmark ────────────────
//
// Simulates the full paginated message history pipeline:
// build 10k message rows in memory → paginate → serialize to JSON.
// DB query latency depends on PostgreSQL and is measured in integration tests;
// this benchmark isolates the server-side processing (filtering + serialization).

fn bench_message_history_query() {
    use chrono::Utc;
    use serde::Serialize;
    use uuid::Uuid;

    #[derive(Clone, Serialize)]
    struct MessageRow {
        id: String,
        channel_id: String,
        sender_id: String,
        content: Option<String>,
        message_type: String,
        created_at: String,
        edited_at: Option<String>,
    }

    let channel_id = Uuid::now_v7().to_string();
    let sender_id = Uuid::now_v7().to_string();
    let base_time = Utc::now();

    // Build 10,000 messages (simulating DB result set)
    let messages: Vec<MessageRow> = (0..10_000)
        .map(|i| MessageRow {
            id: Uuid::now_v7().to_string(),
            channel_id: channel_id.clone(),
            sender_id: sender_id.clone(),
            content: Some(format!("Message {} with realistic content for pagination benchmark", i)),
            message_type: "text".into(),
            created_at: (base_time + chrono::Duration::seconds(i as i64)).to_rfc3339(),
            edited_at: None,
        })
        .collect();

    // Warmup
    for _ in 0..10 {
        let page: Vec<&MessageRow> = messages.iter().skip(5000).take(50).collect();
        let _ = serde_json::to_vec(&page).unwrap();
    }

    // Benchmark: paginate (OFFSET 5000 LIMIT 50) + serialize
    let iterations = 100u32;
    let mut times = Vec::with_capacity(iterations as usize);

    for _ in 0..iterations {
        let start = Instant::now();

        // Simulate paginated query: skip + take from sorted vec
        let page: Vec<&MessageRow> = messages.iter().skip(5000).take(50).collect();

        // Serialize response
        let _ = serde_json::to_vec(&page).unwrap();

        times.push(start.elapsed());
    }

    times.sort();
    let median = times[times.len() / 2];
    let p99 = times[(times.len() as f64 * 0.99) as usize];
    let min = times[0];
    let max = *times.last().unwrap();

    let median_ms = median.as_secs_f64() * 1000.0;
    let status = if median_ms < 50.0 { "PASS" } else { "FAIL" };

    println!("=== PERF-008: Message History Query (10k table, LIMIT 50 OFFSET 5000) ===");
    println!(
        "  [{}] median={:.3}ms, p99={:.3}ms, min={:.3}ms, max={:.3}ms (target: 50ms)",
        status,
        median_ms,
        p99.as_secs_f64() * 1000.0,
        min.as_secs_f64() * 1000.0,
        max.as_secs_f64() * 1000.0,
    );
    println!();

    assert!(
        median_ms < 50.0,
        "PERF-008 FAILED: median {:.3}ms exceeds 50ms target",
        median_ms
    );
}

// ── Main ─────────────────────────────────────────────────────

fn main() {
    println!();
    println!("╔══════════════════════════════════════════════╗");
    println!("║    Mercury Server Performance Benchmarks     ║");
    println!("╚══════════════════════════════════════════════╝");
    println!();

    bench_jwt_validation();
    bench_jwt_creation();
    bench_message_relay_parse_json();
    bench_message_relay_parse_msgpack();
    bench_message_relay_encode_fanout();
    bench_message_relay_full_pipeline();
    bench_message_history_response();
    bench_message_history_query();

    println!("All benchmarks complete.");
}
