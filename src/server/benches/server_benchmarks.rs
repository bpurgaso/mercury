// Server-side performance benchmarks for Mercury.
//
// Benchmarks:
// - JWT validation throughput
// - JWT token creation throughput
// - Message response serialization
//
// Run with: cargo bench --manifest-path src/server/Cargo.toml

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
    println!(
        "  {} iterations in {:.2?}",
        iterations, elapsed
    );
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
    println!(
        "  {} iterations in {:.2?}",
        iterations, elapsed
    );
    println!("  {:.3?} per creation", per_op);
    println!("  {:.0} creations/sec", ops_per_sec);
    println!();
}

// ── Message Serialization Benchmarks ─────────────────────────

fn bench_message_serialization() {
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

    // Create 50 realistic messages (simulating paginated history query)
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

    println!("=== Message History Serialization (50 messages) ===");
    println!(
        "  {} iterations in {:.2?}",
        iterations, elapsed
    );
    println!("  {:.3?} per serialization", per_op);
    println!("  {:.0} serializations/sec", ops_per_sec);
    println!("  Payload size: {} bytes ({:.1} KB)", payload_size, payload_size as f64 / 1024.0);
    println!();
}

// ── MessagePack Serialization Benchmarks ─────────────────────

fn bench_msgpack_serialization() {
    use chrono::Utc;
    use serde::Serialize;
    use uuid::Uuid;

    #[derive(Serialize)]
    struct WsEvent {
        op: u8,
        d: WsMessagePayload,
    }

    #[derive(Serialize)]
    struct WsMessagePayload {
        id: String,
        channel_id: String,
        sender_id: String,
        content: String,
        timestamp: String,
    }

    let event = WsEvent {
        op: 5, // MESSAGE_CREATE
        d: WsMessagePayload {
            id: Uuid::now_v7().to_string(),
            channel_id: Uuid::now_v7().to_string(),
            sender_id: Uuid::now_v7().to_string(),
            content: "Hello, this is a chat message for benchmark testing!".into(),
            timestamp: Utc::now().to_rfc3339(),
        },
    };

    // Warmup
    for _ in 0..100 {
        let _ = rmp_serde::to_vec(&event).unwrap();
    }

    // Benchmark
    let iterations = 50_000u32;
    let start = Instant::now();
    for _ in 0..iterations {
        let _ = rmp_serde::to_vec(&event).unwrap();
    }
    let elapsed = start.elapsed();

    let per_op = elapsed / iterations;
    let ops_per_sec = iterations as f64 / elapsed.as_secs_f64();
    let json_size = serde_json::to_vec(&event).unwrap().len();
    let msgpack_size = rmp_serde::to_vec(&event).unwrap().len();

    println!("=== MessagePack WS Event Serialization ===");
    println!(
        "  {} iterations in {:.2?}",
        iterations, elapsed
    );
    println!("  {:.3?} per serialization", per_op);
    println!("  {:.0} serializations/sec", ops_per_sec);
    println!(
        "  JSON: {} bytes, MsgPack: {} bytes ({:.0}% reduction)",
        json_size,
        msgpack_size,
        (1.0 - msgpack_size as f64 / json_size as f64) * 100.0
    );
    println!();
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
    bench_message_serialization();
    bench_msgpack_serialization();

    println!("All benchmarks complete.");
}
