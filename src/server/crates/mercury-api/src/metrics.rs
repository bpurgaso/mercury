use metrics::describe_counter;
use metrics::describe_gauge;
use metrics::describe_histogram;
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};
use std::sync::OnceLock;

// ── Metric Name Constants ───────────────────────────────────

pub const API_REQUEST_DURATION: &str = "mercury_api_request_duration_seconds";
pub const CONNECTED_CLIENTS: &str = "mercury_connected_clients";
pub const MESSAGES_RELAYED: &str = "mercury_messages_relayed_total";
pub const ACTIVE_CALLS: &str = "mercury_active_calls";
pub const SFU_ROOMS_ACTIVE: &str = "mercury_sfu_rooms_active";
pub const MEDIA_BANDWIDTH_BYTES: &str = "mercury_media_bandwidth_bytes";
pub const DB_POOL_CONNECTIONS: &str = "mercury_db_pool_connections";
pub const DB_POOL_ACQUIRE_TIMEOUTS: &str = "mercury_db_pool_acquire_timeouts_total";

// ── Initialization ──────────────────────────────────────────

/// Global handle — ensures the recorder is installed exactly once even when
/// multiple test servers are created in the same process.
static METRICS_HANDLE: OnceLock<PrometheusHandle> = OnceLock::new();

/// Build a Prometheus recorder and install it as the global metrics recorder.
/// Returns the handle used to render /metrics output.
///
/// Safe to call multiple times (test reentrancy) — subsequent calls return the
/// same handle that was created the first time.
pub fn init_metrics() -> PrometheusHandle {
    METRICS_HANDLE
        .get_or_init(|| {
            let recorder = PrometheusBuilder::new().build_recorder();
            let handle = recorder.handle();

            // Install as global recorder — the metrics! macros use this.
            let _ = metrics::set_global_recorder(recorder);

            // Describe all metrics for the Prometheus HELP text
            describe_histogram!(
                API_REQUEST_DURATION,
                "HTTP request duration in seconds"
            );
            describe_gauge!(CONNECTED_CLIENTS, "Number of active WebSocket connections");
            describe_counter!(MESSAGES_RELAYED, "Total messages relayed through the server");
            describe_gauge!(ACTIVE_CALLS, "Number of active voice/video calls");
            describe_gauge!(SFU_ROOMS_ACTIVE, "Number of active SFU rooms");
            describe_gauge!(
                MEDIA_BANDWIDTH_BYTES,
                "Media bandwidth usage in bytes"
            );
            describe_gauge!(
                DB_POOL_CONNECTIONS,
                "Database pool connection count by state"
            );
            describe_counter!(
                DB_POOL_ACQUIRE_TIMEOUTS,
                "Total database pool acquire timeouts"
            );

            // Initialize gauges to 0 so they appear in /metrics from startup
            metrics::gauge!(CONNECTED_CLIENTS).set(0.0);
            metrics::gauge!(ACTIVE_CALLS).set(0.0);
            metrics::gauge!(SFU_ROOMS_ACTIVE).set(0.0);
            metrics::gauge!(MEDIA_BANDWIDTH_BYTES).set(0.0);

            handle
        })
        .clone()
}
