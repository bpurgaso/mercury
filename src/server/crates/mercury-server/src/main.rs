#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

use std::{net::SocketAddr, sync::Arc};

use anyhow::{Context, Result};
use fred::prelude::{Builder, ClientLike, RedisClient, RedisConfig, ReconnectPolicy};
use rustls::ServerConfig;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tower::Service;
use tracing::info;
use tracing_subscriber::EnvFilter;

use mercury_api::{create_router, AppState};
use mercury_core::config::AppConfig;
use mercury_db::pool::create_pool;

fn load_config() -> Result<AppConfig> {
    let config_path =
        std::env::var("MERCURY_CONFIG_PATH").unwrap_or_else(|_| "config/default.toml".into());

    let config_str = std::fs::read_to_string(&config_path)
        .with_context(|| format!("failed to read config file: {config_path}"))?;

    let mut config: AppConfig =
        toml::from_str(&config_str).context("failed to parse config file")?;

    // Apply environment variable overrides
    if let Ok(v) = std::env::var("MERCURY_SERVER_HOST") {
        config.server.host = v;
    }
    if let Ok(v) = std::env::var("MERCURY_SERVER_PORT") {
        config.server.port = v.parse().context("invalid MERCURY_SERVER_PORT")?;
    }
    if let Ok(v) = std::env::var("MERCURY_DATABASE_URL") {
        config.database.url = v;
    }
    if let Ok(v) = std::env::var("MERCURY_REDIS_URL") {
        config.redis.url = v;
    }
    if let Ok(v) = std::env::var("MERCURY_AUTH_JWT_SECRET") {
        config.auth.jwt_secret = v;
    }
    if let Ok(v) = std::env::var("MERCURY_TLS_CERT_PATH") {
        config.tls.cert_path = v;
    }
    if let Ok(v) = std::env::var("MERCURY_TLS_KEY_PATH") {
        config.tls.key_path = v;
    }
    if let Ok(v) = std::env::var("TURN_SECRET") {
        config.turn.secret = v;
    }

    Ok(config)
}

fn load_tls_config(cert_path: &str, key_path: &str) -> Result<ServerConfig> {
    let cert_file = std::fs::File::open(cert_path)
        .with_context(|| format!("failed to open cert file: {cert_path}"))?;
    let key_file = std::fs::File::open(key_path)
        .with_context(|| format!("failed to open key file: {key_path}"))?;

    let certs: Vec<_> = rustls_pemfile::certs(&mut std::io::BufReader::new(cert_file))
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("failed to parse TLS certificates")?;

    let key = rustls_pemfile::private_key(&mut std::io::BufReader::new(key_file))
        .context("failed to read TLS private key")?
        .context("no private key found in key file")?;

    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("failed to build TLS config")?;

    Ok(config)
}

async fn connect_redis(url: &str) -> Result<RedisClient> {
    let config = RedisConfig::from_url(url).context("invalid Redis URL")?;
    let client = Builder::from_config(config)
        .with_connection_config(|c| {
            c.connection_timeout = std::time::Duration::from_secs(5);
        })
        .set_policy(ReconnectPolicy::new_exponential(0, 100, 5000, 2))
        .build()?;
    client.init().await.context("failed to connect to Redis")?;
    info!("Connected to Redis");
    Ok(client)
}

#[tokio::main]
async fn main() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls crypto provider");

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let config = load_config()?;

    // Connect to database
    let db_pool = create_pool(&config.database)
        .await
        .context("failed to create database pool")?;
    info!("Connected to PostgreSQL");

    // Run migrations
    sqlx::migrate!("../../migrations")
        .run(&db_pool)
        .await
        .context("failed to run database migrations")?;
    info!("Database migrations applied");

    // Connect to Redis
    let redis = connect_redis(&config.redis.url).await?;

    // Build application state
    let state = AppState {
        db: db_pool,
        redis,
        auth_config: Arc::new(config.auth),
        turn_config: Arc::new(config.turn),
    };

    let tls_config = load_tls_config(&config.tls.cert_path, &config.tls.key_path)?;
    let tls_acceptor = TlsAcceptor::from(Arc::new(tls_config));

    let app = create_router(state);
    // Wrap the router so ConnectInfo<SocketAddr> is available to extractors
    let mut make_service = app.into_make_service_with_connect_info::<SocketAddr>();

    let addr: SocketAddr = format!("{}:{}", config.server.host, config.server.port).parse()?;
    let listener = TcpListener::bind(addr).await?;
    info!("Mercury server listening on https://{addr}");

    loop {
        let (stream, remote_addr) = listener.accept().await?;
        let acceptor = tls_acceptor.clone();
        // Create a per-connection service with the remote address injected
        let service = Service::call(&mut make_service, remote_addr)
            .await
            .expect("infallible");

        tokio::spawn(async move {
            let tls_stream = match acceptor.accept(stream).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::debug!("TLS handshake failed from {remote_addr}: {e}");
                    return;
                }
            };

            let io = hyper_util::rt::TokioIo::new(tls_stream);
            let service = hyper_util::service::TowerToHyperService::new(service);

            if let Err(e) = hyper_util::server::conn::auto::Builder::new(
                hyper_util::rt::TokioExecutor::new(),
            )
            .serve_connection(io, service)
            .await
            {
                tracing::debug!("connection error from {remote_addr}: {e}");
            }
        });
    }
}
