<p align="center">
  <img src="assets/mercury_banner.png" alt="Mercury" width="800">
</p>

# Mercury

> [!IMPORTANT]
> Mercury is provided as is. It is a proof of concept project for me to learn agentic software development strategies. Mercury works, and like all software, likely contains bugs. I plan to continue working on Mercury for my communities, and if there is interest, for everyone else.

A self-hosted, end-to-end encrypted communication platform supporting text, voice, and video. Deploy it yourself with a single Docker container and own your community's data.

## Features

- **Tiered Encryption** -- Channels choose their encryption model at creation time:
  - _End-to-End Encrypted_: DMs and private channels use Signal Protocol (X3DH + Double Ratchet). The server never sees plaintext.
  - _Server-Side Encrypted_: Standard channels use TLS + at-rest encryption, enabling full search and moderation.
- **Voice & Video** -- SFU-based calls in channels and DMs with E2E-encrypted media via WebRTC Insertable Streams.
- **Self-Hosted** -- Single Docker container with bundled TURN server. Designed for 500--5,000+ concurrent users per instance.
- **Moderation Tools** -- Reporting, metadata-based abuse detection, and an operator dashboard.
- **Desktop Client** -- Electron app with encrypted local storage, per-device identity keys, and full HMR development support.

## Tech Stack

| Layer    | Technology                                         |
| -------- | -------------------------------------------------- |
| Server   | Rust, Tokio, Axum, str0m (WebRTC SFU)              |
| Database | PostgreSQL 16+, Redis 7+                           |
| Client   | Electron 33+, React 19, TypeScript, Tailwind CSS 4 |
| Crypto   | libsodium, ring, RustCrypto                        |
| Build    | Cargo workspaces, Vite (electron-vite), Docker     |

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Rust 1.88+ with `cargo-watch`, `cargo-nextest`, `sqlx-cli`
- Node.js 24+ with pnpm
- mkcert (for local TLS certificates)

See [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) for full system requirements and step-by-step setup.

### Development

```bash
# Generate local TLS certs
mkcert -install
./scripts/generate-certs.sh

# Configure environment
cp .env.example .env

# Start infrastructure (Postgres, Redis, coturn)
docker compose up -d

# Run database migrations
cd src/server
export DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury"
sqlx migrate run --source migrations/

# Install client dependencies
cd ../client
pnpm install
pnpm run electron-rebuild
```

Then start development servers (or use `./scripts/dev.sh`):

```bash
# Terminal 1 -- Rust server
cd src/server
cargo watch -x run        # https://localhost:8443

# Terminal 2 -- Electron client
cd src/client
pnpm dev
```

### Production

```bash
# Build server image
docker build -t mercury-server:latest .

# Build client
cd src/client
pnpm build:linux    # or build:mac / build:win
```

See [docs/operator-guide.md](docs/operator-guide.md) for production deployment, configuration, and operations.

## Testing

```bash
# Server
cd src/server
cargo nextest run

# Client
cd src/client
pnpm test

# Full suite
./scripts/test-all.sh
```

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
