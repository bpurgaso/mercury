#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

use std::{net::SocketAddr, sync::Arc};

use anyhow::{Context, Result};
use rustls::ServerConfig;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tracing::info;
use tracing_subscriber::EnvFilter;

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

#[tokio::main]
async fn main() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls crypto provider");

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let host = std::env::var("MERCURY_SERVER_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port: u16 = std::env::var("MERCURY_SERVER_PORT")
        .unwrap_or_else(|_| "8443".into())
        .parse()
        .context("invalid MERCURY_SERVER_PORT")?;
    let cert_path = std::env::var("MERCURY_TLS_CERT_PATH")
        .unwrap_or_else(|_| "../../certs/cert.pem".into());
    let key_path = std::env::var("MERCURY_TLS_KEY_PATH")
        .unwrap_or_else(|_| "../../certs/key.pem".into());

    let tls_config = load_tls_config(&cert_path, &key_path)?;
    let tls_acceptor = TlsAcceptor::from(Arc::new(tls_config));

    let app = mercury_api::create_router();

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = TcpListener::bind(addr).await?;
    info!("Mercury server listening on https://{addr}");

    loop {
        let (stream, remote_addr) = listener.accept().await?;
        let acceptor = tls_acceptor.clone();
        let app = app.clone();

        tokio::spawn(async move {
            let tls_stream = match acceptor.accept(stream).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::debug!("TLS handshake failed from {remote_addr}: {e}");
                    return;
                }
            };

            let io = hyper_util::rt::TokioIo::new(tls_stream);
            let service = hyper_util::service::TowerToHyperService::new(app);

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
