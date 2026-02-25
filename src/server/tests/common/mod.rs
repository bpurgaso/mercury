#![allow(dead_code)]

use std::net::SocketAddr;
use std::time::Duration;

use fred::prelude::{Builder, ClientLike, RedisConfig, ReconnectPolicy};
use futures_util::{SinkExt, StreamExt};
use mercury_core::config::{
    AppConfig, AudioConfig, AuthConfig, BandwidthConfig, DatabaseConfig, IceConfig, MediaConfig,
    RedisConfig as MercuryRedisConfig, ServerConfig, TlsConfig, TurnConfig, VideoConfig,
};
use reqwest::Client;
use serde_json::{json, Value};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

/// Default timeout for fast operations (HTTP requests, single WS messages).
const FAST_TIMEOUT: Duration = Duration::from_secs(5);

/// Longer timeout for debounce-related tests.
const DEBOUNCE_TIMEOUT: Duration = Duration::from_secs(20);

// ── TestServer ──────────────────────────────────────────────

pub struct TestServer {
    pub addr: SocketAddr,
    pub db: sqlx::PgPool,
    pub redis: fred::prelude::RedisClient,
}

impl TestServer {
    pub async fn start() -> Self {
        Self::start_with_auth_rate_limit(5).await
    }

    pub async fn start_with_auth_rate_limit(auth_rate_limit_per_min: u64) -> Self {
        let database_url = std::env::var("DATABASE_URL")
            .or_else(|_| std::env::var("MERCURY_DATABASE_URL"))
            .unwrap_or_else(|_| {
                "postgres://mercury:mercury@localhost:5432/mercury_test".to_string()
            });
        let redis_url = std::env::var("MERCURY_REDIS_URL")
            .unwrap_or_else(|_| "redis://localhost:6379".to_string());

        let config = AppConfig {
            server: ServerConfig {
                host: "127.0.0.1".to_string(),
                port: 0,
                heartbeat_interval_secs: 5,
                auth_rate_limit_per_min,
                ws_rate_limit_per_sec: 10,
            },
            database: DatabaseConfig {
                url: database_url.clone(),
                max_connections: 5,
                min_connections: 1,
                acquire_timeout_seconds: 5,
                idle_timeout_seconds: 60,
                max_lifetime_seconds: 300,
            },
            redis: MercuryRedisConfig {
                url: redis_url.clone(),
            },
            auth: AuthConfig {
                jwt_secret: "test-secret-for-integration-tests".to_string(),
                jwt_expiry_minutes: 60,
                refresh_token_expiry_days: 30,
                argon2_memory_kib: 16384,
                argon2_iterations: 1,
                argon2_parallelism: 1,
            },
            tls: TlsConfig {
                cert_path: String::new(),
                key_path: String::new(),
            },
            turn: TurnConfig {
                enabled: true,
                secret: "test-turn-secret".to_string(),
                urls: vec!["turn:localhost:3478".to_string()],
                credential_ttl_seconds: 86400,
            },
            media: MediaConfig {
                dedicated_cores: 1,
                max_participants_per_room: 25,
                empty_room_timeout_secs: 0, // immediate cleanup for tests
                udp_port_range_start: 10000,
                udp_port_range_end: 10100,
                ice: IceConfig {
                    turn_secret: "test-turn-secret".to_string(),
                    turn_urls: vec!["turn:localhost:3478".to_string()],
                    stun_urls: vec!["stun:stun.l.google.com:19302".to_string()],
                },
                audio: AudioConfig {
                    max_bitrate_kbps: 128,
                    preferred_bitrate_kbps: 64,
                },
                video: VideoConfig::default(),
                bandwidth: BandwidthConfig {
                    total_mbps: 100,
                    per_user_kbps: 4000,
                },
            },
        };

        // Create a separate pool for test cleanup
        let db = sqlx::PgPool::connect(&database_url)
            .await
            .expect("failed to connect to test database");

        // Create Redis client for test cleanup
        let redis_config =
            RedisConfig::from_url(&redis_url).expect("invalid Redis URL");
        let redis = Builder::from_config(redis_config)
            .with_connection_config(|c| {
                c.connection_timeout = Duration::from_secs(5);
            })
            .set_policy(ReconnectPolicy::new_exponential(0, 100, 5000, 2))
            .build()
            .expect("failed to build Redis client");
        redis
            .init()
            .await
            .expect("failed to connect to Redis");

        let addr = mercury_server::start_server(config)
            .await
            .expect("failed to start test server");

        TestServer { addr, db, redis }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn ws_url(&self, token: &str) -> String {
        format!("ws://{}/ws?token={}", self.addr, token)
    }

    pub fn client(&self) -> TestClient {
        TestClient::new(self.base_url())
    }

    pub async fn ws_client(&self, token: &str) -> TestWsClient {
        TestWsClient::connect(&self.ws_url(token)).await
    }
}

// ── Setup (truncate tables + flush Redis) ───────────────────

pub async fn setup(server: &TestServer) {
    // Truncate all tables in reverse dependency order.
    // Retry on deadlock — background SFU event handlers may hold row locks
    // that conflict with TRUNCATE's AccessExclusiveLock.
    let truncate_sql = "TRUNCATE TABLE
            abuse_signals,
            mod_audit_log,
            reports,
            channel_mutes,
            server_bans,
            user_blocks,
            key_backups,
            device_lists,
            one_time_prekeys,
            device_identity_keys,
            devices,
            message_recipients,
            messages,
            dm_members,
            dm_channels,
            channel_members,
            server_members,
            channels,
            servers,
            users
        CASCADE";
    for attempt in 0..5 {
        match sqlx::query(truncate_sql).execute(&server.db).await {
            Ok(_) => break,
            Err(e) if attempt < 4 => {
                // Deadlock or lock timeout — wait and retry
                tokio::time::sleep(std::time::Duration::from_millis(100 * (attempt + 1) as u64))
                    .await;
                eprintln!("truncate retry {}: {e}", attempt + 1);
            }
            Err(e) => panic!("failed to truncate tables after retries: {e}"),
        }
    }

    // Flush all Redis keys
    let _: () = server
        .redis
        .flushall::<()>(false)
        .await
        .expect("failed to flush Redis");
}

// ── TestClient (HTTP) ───────────────────────────────────────

pub struct TestClient {
    client: Client,
    pub base_url: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub user_id: Option<String>,
}

impl TestClient {
    pub fn new(base_url: String) -> Self {
        let client = Client::builder()
            .timeout(FAST_TIMEOUT)
            .build()
            .expect("failed to build reqwest client");
        TestClient {
            client,
            base_url,
            access_token: None,
            refresh_token: None,
            user_id: None,
        }
    }

    /// Register and return (status_code, response_body).
    pub async fn register_raw(
        &mut self,
        username: &str,
        email: &str,
        password: &str,
    ) -> (reqwest::StatusCode, Value) {
        let resp = self
            .client
            .post(format!("{}/auth/register", self.base_url))
            .json(&json!({
                "username": username,
                "email": email,
                "password": password,
            }))
            .send()
            .await
            .expect("register request failed");

        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(json!({}));

        if status.is_success() {
            self.access_token = body["access_token"].as_str().map(String::from);
            self.refresh_token = body["refresh_token"].as_str().map(String::from);
            self.user_id = body["user_id"].as_str().map(String::from);
        }

        (status, body)
    }

    /// Login and return (status_code, response_body).
    pub async fn login_raw(
        &mut self,
        email: &str,
        password: &str,
    ) -> (reqwest::StatusCode, Value) {
        let resp = self
            .client
            .post(format!("{}/auth/login", self.base_url))
            .json(&json!({
                "email": email,
                "password": password,
            }))
            .send()
            .await
            .expect("login request failed");

        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(json!({}));

        if status.is_success() {
            self.access_token = body["access_token"].as_str().map(String::from);
            self.refresh_token = body["refresh_token"].as_str().map(String::from);
            self.user_id = body["user_id"].as_str().map(String::from);
        }

        (status, body)
    }

    pub async fn get(&self, path: &str) -> (reqwest::StatusCode, Value) {
        let resp = self
            .client
            .get(format!("{}{}", self.base_url, path))
            .send()
            .await
            .expect("GET request failed");
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(json!({}));
        (status, body)
    }

    pub async fn get_text(&self, path: &str) -> (reqwest::StatusCode, String) {
        let resp = self
            .client
            .get(format!("{}{}", self.base_url, path))
            .send()
            .await
            .expect("GET request failed");
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        (status, body)
    }

    pub async fn get_authed(&self, path: &str) -> (reqwest::StatusCode, Value) {
        let token = self
            .access_token
            .as_ref()
            .expect("no access token — login first");
        let resp = self
            .client
            .get(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .expect("GET authed request failed");
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(json!({}));
        (status, body)
    }

    pub async fn post_authed(
        &self,
        path: &str,
        body: &Value,
    ) -> (reqwest::StatusCode, Value) {
        let token = self
            .access_token
            .as_ref()
            .expect("no access token — login first");
        let resp = self
            .client
            .post(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .json(body)
            .send()
            .await
            .expect("POST authed request failed");
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(json!({}));
        (status, body)
    }

    pub async fn post_authed_status(
        &self,
        path: &str,
        body: &Value,
    ) -> reqwest::StatusCode {
        let token = self
            .access_token
            .as_ref()
            .expect("no access token — login first");
        let resp = self
            .client
            .post(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .json(body)
            .send()
            .await
            .expect("POST authed request failed");
        resp.status()
    }

    pub async fn post_json(
        &self,
        path: &str,
        body: &Value,
    ) -> (reqwest::StatusCode, Value) {
        let resp = self
            .client
            .post(format!("{}{}", self.base_url, path))
            .json(body)
            .send()
            .await
            .expect("POST request failed");
        let status = resp.status();
        let rbody: Value = resp.json().await.unwrap_or(json!({}));
        (status, rbody)
    }

    pub async fn put_authed(
        &self,
        path: &str,
        body: &Value,
    ) -> (reqwest::StatusCode, Value) {
        let token = self
            .access_token
            .as_ref()
            .expect("no access token — login first");
        let resp = self
            .client
            .put(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .json(body)
            .send()
            .await
            .expect("PUT authed request failed");
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(json!({}));
        (status, body)
    }

    pub async fn put_authed_status(
        &self,
        path: &str,
        body: &Value,
    ) -> reqwest::StatusCode {
        let token = self
            .access_token
            .as_ref()
            .expect("no access token — login first");
        let resp = self
            .client
            .put(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .json(body)
            .send()
            .await
            .expect("PUT authed request failed");
        resp.status()
    }

    pub async fn patch_authed(
        &self,
        path: &str,
        body: &Value,
    ) -> (reqwest::StatusCode, Value) {
        let token = self
            .access_token
            .as_ref()
            .expect("no access token — login first");
        let resp = self
            .client
            .patch(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .json(body)
            .send()
            .await
            .expect("PATCH authed request failed");
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(json!({}));
        (status, body)
    }

    pub async fn delete_authed(&self, path: &str) -> reqwest::StatusCode {
        let token = self
            .access_token
            .as_ref()
            .expect("no access token — login first");
        let resp = self
            .client
            .delete(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .expect("DELETE authed request failed");
        resp.status()
    }

    /// Send a raw POST with custom headers — returns (status, headers, body).
    pub async fn post_raw(
        &self,
        path: &str,
        body: &Value,
    ) -> (reqwest::StatusCode, reqwest::header::HeaderMap, Value) {
        let resp = self
            .client
            .post(format!("{}{}", self.base_url, path))
            .json(body)
            .send()
            .await
            .expect("POST request failed");
        let status = resp.status();
        let headers = resp.headers().clone();
        let rbody: Value = resp.json().await.unwrap_or(json!({}));
        (status, headers, rbody)
    }

    /// Make a GET request that expects to receive response headers too.
    pub async fn get_with_headers(
        &self,
        path: &str,
    ) -> (reqwest::StatusCode, reqwest::header::HeaderMap, String) {
        let resp = self
            .client
            .get(format!("{}{}", self.base_url, path))
            .send()
            .await
            .expect("GET request failed");
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = resp.text().await.unwrap_or_default();
        (status, headers, body)
    }
}

// ── TestWsClient (WebSocket) ────────────────────────────────

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

pub struct TestWsClient {
    stream: WsStream,
}

impl TestWsClient {
    pub async fn connect(url: &str) -> Self {
        let (stream, _response) =
            tokio_tungstenite::connect_async(url)
                .await
                .expect("WebSocket connect failed");
        TestWsClient { stream }
    }

    /// Try connecting; returns Ok(Self) or Err with the tungstenite error.
    pub async fn try_connect(
        url: &str,
    ) -> Result<Self, tokio_tungstenite::tungstenite::Error> {
        let (stream, _response) =
            tokio_tungstenite::connect_async(url).await?;
        Ok(TestWsClient { stream })
    }

    pub async fn send_json(&mut self, value: &Value) {
        let text = serde_json::to_string(value).expect("failed to serialize JSON");
        self.stream
            .send(Message::Text(text.into()))
            .await
            .expect("failed to send WS message");
    }

    /// Receive the next JSON message within the default timeout.
    pub async fn receive_json(&mut self) -> Option<Value> {
        self.receive_json_timeout(FAST_TIMEOUT).await
    }

    /// Receive the next JSON message within the given timeout.
    pub async fn receive_json_timeout(&mut self, dur: Duration) -> Option<Value> {
        match timeout(dur, self.next_text()).await {
            Ok(Some(text)) => serde_json::from_str(&text).ok(),
            _ => None,
        }
    }

    /// Receive a close frame. Returns the close code if one is received.
    pub async fn receive_close(&mut self) -> Option<u16> {
        self.receive_close_timeout(FAST_TIMEOUT).await
    }

    pub async fn receive_close_timeout(&mut self, dur: Duration) -> Option<u16> {
        match timeout(dur, self.next_close_or_text()).await {
            Ok(Some(code)) => Some(code),
            _ => None,
        }
    }

    /// Send an identify message and return the READY payload.
    pub async fn identify(&mut self, token: &str, device_id: &str) -> Value {
        self.send_json(&json!({
            "op": "identify",
            "d": {
                "token": token,
                "device_id": device_id,
            }
        }))
        .await;

        let ready = self
            .receive_json()
            .await
            .expect("did not receive READY after identify");
        assert_eq!(
            ready["t"], "READY",
            "expected READY event, got: {}",
            ready["t"]
        );
        ready
    }

    /// Send a heartbeat with the given sequence number.
    pub async fn send_heartbeat(&mut self, seq: u64) {
        self.send_json(&json!({
            "op": "heartbeat",
            "d": { "seq": seq }
        }))
        .await;
    }

    /// Send a resume message.
    pub async fn send_resume(&mut self, token: &str, session_id: &str, seq: u64) {
        self.send_json(&json!({
            "op": "resume",
            "d": {
                "token": token,
                "session_id": session_id,
                "seq": seq,
            }
        }))
        .await;
    }

    /// Close the connection.
    pub async fn close(&mut self) {
        let _ = self.stream.close(None).await;
    }

    /// Drain all pending messages, collecting events of a specific type.
    pub async fn collect_events(&mut self, event_type: &str, dur: Duration) -> Vec<Value> {
        let mut events = Vec::new();
        loop {
            match timeout(dur, self.next_text()).await {
                Ok(Some(text)) => {
                    if let Ok(msg) = serde_json::from_str::<Value>(&text) {
                        if msg["t"] == event_type {
                            events.push(msg);
                        }
                    }
                }
                _ => break,
            }
        }
        events
    }

    /// Send a MessagePack binary frame.
    pub async fn send_binary(&mut self, bytes: &[u8]) {
        self.stream
            .send(Message::Binary(bytes.to_vec().into()))
            .await
            .expect("failed to send binary WS message");
    }

    /// Send a MessagePack-encoded message_send op.
    pub async fn send_msgpack(&mut self, value: &rmpv::Value) {
        let mut buf = Vec::new();
        rmpv::encode::write_value(&mut buf, value).expect("failed to encode msgpack");
        self.send_binary(&buf).await;
    }

    /// Receive the next message (text or binary) within the given timeout.
    /// Returns the decoded rmpv::Value from either JSON text or MessagePack binary.
    pub async fn receive_any_timeout(&mut self, dur: Duration) -> Option<Value> {
        match timeout(dur, self.next_any()).await {
            Ok(Some(WsFrame::Text(text))) => serde_json::from_str(&text).ok(),
            Ok(Some(WsFrame::Binary(bytes))) => {
                // Decode MessagePack to rmpv::Value, then convert to serde_json::Value
                let val: rmpv::Value = rmpv::decode::read_value(&mut &bytes[..]).ok()?;
                rmpv_to_json(&val)
            }
            _ => None,
        }
    }

    /// Receive the next message (text or binary) within default timeout.
    pub async fn receive_any(&mut self) -> Option<Value> {
        self.receive_any_timeout(FAST_TIMEOUT).await
    }

    /// Receive a binary (MessagePack) frame within timeout, return raw bytes.
    pub async fn receive_binary_timeout(&mut self, dur: Duration) -> Option<Vec<u8>> {
        match timeout(dur, self.next_binary()).await {
            Ok(Some(bytes)) => Some(bytes),
            _ => None,
        }
    }

    /// Drain all pending messages (text or binary), collecting events of a specific type.
    pub async fn collect_any_events(&mut self, event_type: &str, dur: Duration) -> Vec<Value> {
        let mut events = Vec::new();
        loop {
            match self.receive_any_timeout(dur).await {
                Some(msg) => {
                    if msg["t"] == event_type {
                        events.push(msg);
                    }
                }
                None => break,
            }
        }
        events
    }

    // ── Private helpers ─────────────────────────────────────

    async fn next_text(&mut self) -> Option<String> {
        loop {
            match self.stream.next().await {
                Some(Ok(Message::Text(text))) => return Some(text.to_string()),
                Some(Ok(Message::Close(_))) => return None,
                Some(Err(_)) => return None,
                None => return None,
                _ => continue, // skip Ping/Pong/Binary
            }
        }
    }

    async fn next_binary(&mut self) -> Option<Vec<u8>> {
        loop {
            match self.stream.next().await {
                Some(Ok(Message::Binary(bytes))) => return Some(bytes.to_vec()),
                Some(Ok(Message::Close(_))) => return None,
                Some(Err(_)) => return None,
                None => return None,
                _ => continue,
            }
        }
    }

    async fn next_any(&mut self) -> Option<WsFrame> {
        loop {
            match self.stream.next().await {
                Some(Ok(Message::Text(text))) => return Some(WsFrame::Text(text.to_string())),
                Some(Ok(Message::Binary(bytes))) => return Some(WsFrame::Binary(bytes.to_vec())),
                Some(Ok(Message::Close(_))) => return None,
                Some(Err(_)) => return None,
                None => return None,
                _ => continue,
            }
        }
    }

    async fn next_close_or_text(&mut self) -> Option<u16> {
        loop {
            match self.stream.next().await {
                Some(Ok(Message::Close(Some(frame)))) => {
                    return Some(frame.code.into());
                }
                Some(Ok(Message::Close(None))) => return Some(1000),
                Some(Err(_)) => return None,
                None => return None,
                _ => continue,
            }
        }
    }
}

enum WsFrame {
    Text(String),
    Binary(Vec<u8>),
}

/// Convert an rmpv::Value to a serde_json::Value.
fn rmpv_to_json(val: &rmpv::Value) -> Option<Value> {
    match val {
        rmpv::Value::Nil => Some(Value::Null),
        rmpv::Value::Boolean(b) => Some(Value::Bool(*b)),
        rmpv::Value::Integer(i) => {
            if let Some(n) = i.as_u64() {
                Some(Value::Number(n.into()))
            } else if let Some(n) = i.as_i64() {
                Some(Value::Number(n.into()))
            } else {
                None
            }
        }
        rmpv::Value::F32(f) => serde_json::Number::from_f64(*f as f64).map(Value::Number),
        rmpv::Value::F64(f) => serde_json::Number::from_f64(*f).map(Value::Number),
        rmpv::Value::String(s) => Some(Value::String(s.as_str().unwrap_or("").to_string())),
        rmpv::Value::Binary(b) => {
            // Represent binary as array of numbers for JSON
            Some(Value::Array(b.iter().map(|&byte| Value::Number(byte.into())).collect()))
        }
        rmpv::Value::Array(arr) => {
            let items: Option<Vec<Value>> = arr.iter().map(rmpv_to_json).collect();
            items.map(Value::Array)
        }
        rmpv::Value::Map(pairs) => {
            let mut map = serde_json::Map::new();
            for (k, v) in pairs {
                let key = match k {
                    rmpv::Value::String(s) => s.as_str().unwrap_or("").to_string(),
                    rmpv::Value::Integer(i) => i.to_string(),
                    _ => continue,
                };
                if let Some(val) = rmpv_to_json(v) {
                    map.insert(key, val);
                }
            }
            Some(Value::Object(map))
        }
        rmpv::Value::Ext(_, _) => None,
    }
}
