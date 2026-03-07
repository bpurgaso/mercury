# ── Stage 1: Build ───────────────────────────────────────────
FROM rust:1.82-bookworm AS builder

WORKDIR /build

# Copy workspace manifests first for layer caching
COPY src/server/Cargo.toml src/server/Cargo.toml
COPY src/server/Cargo.lock src/server/Cargo.lock
COPY src/server/crates/ src/server/crates/

# Copy source code
COPY src/server/config/ src/server/config/
COPY src/server/migrations/ src/server/migrations/

WORKDIR /build/src/server
RUN cargo build --release --bin mercury-server

# ── Stage 2: Runtime ────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r mercury && useradd -r -g mercury -d /app -s /sbin/nologin mercury

COPY --from=builder /build/src/server/target/release/mercury-server /usr/local/bin/mercury-server
COPY src/server/config/default.toml /app/config/default.toml

RUN chown -R mercury:mercury /app
WORKDIR /app
USER mercury

ENV MERCURY_CONFIG_PATH=/app/config/default.toml

EXPOSE 8443
EXPOSE 9090

ENTRYPOINT ["mercury-server"]
