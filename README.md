<p align="center">
  <img src="assets/mercury_banner.png" alt="Mercury" width="800">
</p>

<p align="center">
  <strong>A self-hosted, end-to-end encrypted communication platform for text, voice, and video.</strong><br>
  Deploy with a single Docker container and own your community's data.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/rust-1.88%2B-orange.svg" alt="Rust">
  <img src="https://img.shields.io/badge/typescript-5.x-blue.svg" alt="TypeScript">
</p>

> [!NOTE]
> Mercury is an actively developed proof of concept exploring agentic software development. It is functional and under continuous improvement — first for my own communities, and if there is interest, for everyone else.

## Features

- **Tiered Encryption** — Channels choose their encryption model at creation time:
  - _End-to-End Encrypted_: DMs and private channels use Signal Protocol (X3DH + Double Ratchet). The server never sees plaintext.
  - _Server-Side Encrypted_: Standard channels use TLS + at-rest encryption, enabling full search and moderation.
- **Voice & Video** — SFU-based calls in channels and DMs with E2E-encrypted media via WebRTC Insertable Streams.
- **Self-Hosted** — Single Docker container with bundled TURN server. Designed for 500–5,000+ concurrent users per instance.
- **Moderation Tools** — Reporting, metadata-based abuse detection, and an operator dashboard.
- **Desktop Client** — Electron app with encrypted local storage, per-device identity keys, and full HMR development support.

## Tech Stack

| Layer    | Technology                                         |
| -------- | -------------------------------------------------- |
| Server   | Rust, Tokio, Axum, str0m (WebRTC SFU)              |
| Database | PostgreSQL 16+, Redis 7+                           |
| Client   | Electron 33+, React 19, TypeScript, Tailwind CSS 4 |
| Crypto   | libsodium, ring, RustCrypto                        |
| Build    | Cargo workspaces, Vite (electron-vite), Docker     |

## Quick Start

```bash
# Setup environment and infrastructure
./scripts/generate-certs.sh
cp .env.example .env
docker compose up -d

# Start development (server + client)
./scripts/dev.sh
```

See [Getting Started](docs/GETTING_STARTED.md) for full prerequisites, system requirements, and step-by-step setup.

For production deployment, see the [Operator Guide](docs/operator-guide.md).

## Testing

```bash
./scripts/test-all.sh
```

Or run individually: `cargo nextest run -j1` (server, must run sequentially) and `pnpm test` (client). See [Test Spec](specs/TESTSPEC.md) for coverage details.

## Project Structure

```
mercury/
├── src/
│   ├── server/              # Rust backend (Cargo workspace)
│   │   ├── crates/
│   │   │   ├── mercury-server/      # Binary entry point
│   │   │   ├── mercury-api/         # HTTP & WebSocket handlers
│   │   │   ├── mercury-core/        # Domain models & config
│   │   │   ├── mercury-db/          # Database queries (sqlx)
│   │   │   ├── mercury-auth/        # Authentication (Argon2, JWT)
│   │   │   ├── mercury-crypto/      # Key bundle validation
│   │   │   ├── mercury-media/       # SFU & WebRTC signaling
│   │   │   └── mercury-moderation/  # Abuse detection & reporting
│   │   ├── migrations/              # PostgreSQL migrations
│   │   └── tests/                   # Integration tests
│   └── client/              # Electron + React frontend
│       └── src/
│           ├── main/                # Electron main process
│           ├── renderer/            # React UI, stores, services
│           ├── worker/              # Crypto worker thread
│           └── shared/              # Wire format & opcodes
├── docs/                    # Operator & developer docs
├── specs/                   # Technical specifications
└── scripts/                 # Dev utilities
```

## Documentation

| Document                                           | Description                        |
| -------------------------------------------------- | ---------------------------------- |
| [Getting Started](docs/GETTING_STARTED.md)         | Development environment setup      |
| [Operator Guide](docs/operator-guide.md)           | Production deployment & operations |
| [Implementation Plan](docs/IMPLEMENTATION_PLAN.md) | Phased development roadmap         |
| [Server Spec](specs/server-spec.md)                | Server architecture & API design   |
| [Client Spec](specs/client-spec.md)                | Client architecture & UI design    |
| [Test Spec](specs/TESTSPEC.md)                     | Test strategy & coverage           |

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
