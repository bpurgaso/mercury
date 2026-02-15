# Mercury — Developer Getting Started Guide

This guide walks you through setting up a local development environment for Mercury from a fresh machine. By the end, you'll have the Rust server, Electron client, and all infrastructure services running locally.

---

## Prerequisites

### Hardware

Mercury's development stack is moderately resource-intensive due to Rust compilation and Electron:

- **RAM:** 16 GB minimum (Rust `cargo build` + Electron + Docker services peak at ~10 GB)
- **Disk:** 10 GB free (Rust target directory alone can reach 3-4 GB)
- **CPU:** 4+ cores recommended (Rust compilation parallelizes heavily)

### Operating System

Mercury is developed and tested on:

- **macOS** 13+ (Intel or Apple Silicon)
- **Linux** Ubuntu 22.04+ / Fedora 38+ (or equivalent)
- **Windows** 10+ with WSL2 (native Windows builds work but WSL2 is recommended for Docker and shell script compatibility)

> **Windows users:** All commands in this guide assume a Unix shell. On Windows, use WSL2 with Ubuntu. Install Docker Desktop with the WSL2 backend enabled.

---

## Step 1: System Dependencies

### macOS

```bash
# Xcode command line tools (C/C++ compiler, linker)
xcode-select --install

# Homebrew packages
brew install openssl pkg-config cmake mkcert
```

### Ubuntu / Debian

```bash
sudo apt update && sudo apt install -y \
  build-essential \
  libssl-dev \
  pkg-config \
  cmake \
  curl \
  git \
  libnss3-tools          # Required for mkcert

# Install mkcert
curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64"
chmod +x mkcert-v*-linux-amd64
sudo mv mkcert-v*-linux-amd64 /usr/local/bin/mkcert

# Electron dependencies (for running on Linux desktops)
sudo apt install -y \
  libgtk-3-0 \
  libnotify4 \
  libnss3 \
  libxss1 \
  libxtst6 \
  xdg-utils \
  libatspi2.0-0 \
  libsecret-1-dev        # Required for Electron safeStorage on Linux
```

### Fedora / RHEL

```bash
sudo dnf5 group install -y "Development Tools"
sudo dnf5 install -y \
  openssl-devel \
  pkg-config \
  cmake \
  curl \
  git \
  nss-tools \
  libsecret-devel

# Install mkcert
curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64"
chmod +x mkcert-v*-linux-amd64
sudo mv mkcert-v*-linux-amd64 /usr/local/bin/mkcert
```

---

## Step 2: Rust Toolchain

Install Rust via `rustup` (the official installer). Do not use your OS package manager — it will be outdated.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Select the default installation (stable toolchain). Then reload your shell:

```bash
source "$HOME/.cargo/env"
```

Verify:

```bash
rustc --version    # Should be 1.78+ (stable)
cargo --version
```

### Cargo Tools

```bash
# File watcher for hot-reload during development
cargo install cargo-watch

# Fast parallel test runner (preferred over cargo test)
cargo install cargo-nextest

# Database migration CLI
cargo install sqlx-cli --features postgres

# (Optional) Faster linker — significantly speeds up incremental Rust builds
# macOS: uses Apple's linker by default (already fast)
# Linux:
sudo apt install -y lld    # Ubuntu/Debian
sudo dnf5 install -y lld    # Fedora
```

If you installed `lld`, create a Cargo config to use it. This file already exists in the repo, but if you're setting up from scratch:

```bash
# src/server/.cargo/config.toml
mkdir -p src/server/.cargo
cat > src/server/.cargo/config.toml << 'EOF'
[target.x86_64-unknown-linux-gnu]
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=lld"]

[target.aarch64-unknown-linux-gnu]
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=lld"]
EOF
```

---

## Step 3: Node.js and pnpm

Install Node.js 24 LTS via `nvm` (Node Version Manager). Do not install Node.js from your OS package manager.

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc   # or ~/.zshrc

# Install Node.js 24 LTS
nvm install 24
nvm use 24
nvm alias default 24
```

Verify:

```bash
node --version     # Should be v24.x.x
```

Install pnpm globally:

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

Verify:

```bash
pnpm --version     # Should be 9.x+
```

> **Why pnpm over npm?** pnpm's content-addressable store avoids duplicate downloads, and its strict dependency resolution catches phantom dependency bugs early. It also handles Electron's native module rebuilds (`better-sqlite3`, `libsodium`) more reliably than npm.

---

## Step 4: Docker and Docker Compose

Mercury uses Docker only for infrastructure services (Postgres, Redis, coturn). The server and client run natively during development for fast iteration.

### macOS

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/). Allocate at least 4 GB RAM in Docker Desktop → Settings → Resources.

### Linux

```bash
# Install Docker Engine (not Docker Desktop)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Docker Compose (v2 plugin, included with modern Docker Engine)
docker compose version    # Should be v2.x+
```

### Windows (WSL2)

Install Docker Desktop with the WSL2 backend. In Docker Desktop settings, enable "Use the WSL 2 based engine" and enable integration with your WSL2 distro.

### Verify

```bash
docker run --rm hello-world
docker compose version
```

---

## Step 5: Clone and Bootstrap

```bash
git clone https://github.com/your-org/mercury.git
cd mercury
```

### Generate Local TLS Certificates

Mercury requires TLS even in development (WebSocket Secure, DTLS-SRTP, Electron's `safeStorage` on some platforms). The `mkcert` tool generates locally-trusted certificates.

```bash
# Install the local CA (one-time, adds to your system trust store)
mkcert -install

# Generate certs for local development
./scripts/generate-certs.sh
```

This creates certificates in `certs/` for `localhost` and `127.0.0.1`. The Docker Compose file mounts this directory into the coturn container.

### Start Infrastructure Services

```bash
# Copy the environment template
cp .env.example .env

# Start Postgres, Redis, and coturn
docker compose up -d
```

Verify services are healthy:

```bash
docker compose ps
# All three services should show "healthy" or "running"

# Quick connection test
docker compose exec postgres pg_isready       # Should say "accepting connections"
docker compose exec redis redis-cli ping       # Should say "PONG"
```

### Run Database Migrations

> **Bootstrapping a new repo?** If the `src/server/migrations/` directory doesn't exist yet, skip this step. Migration files are created in Phase 2 of `IMPLEMENTATION_PLAN.md`. Come back here once they're written.

```bash
cd src/server

# sqlx-cli uses DATABASE_URL (standard convention, not MERCURY_ prefixed)
export DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury"

# Run all migrations
sqlx migrate run --source migrations/
```

Verify the schema was created:

```bash
docker compose exec postgres psql -U mercury -d mercury -c "\dt"
# Should list: users, devices, servers, channels, server_members, messages, 
#              message_recipients, dm_channels, dm_members, user_blocks, etc.
```

### Install Client Dependencies

> **Bootstrapping a new repo?** If `src/client/package.json` doesn't exist yet, skip this step. The client scaffold is created in Phase 1 of `IMPLEMENTATION_PLAN.md`.

```bash
cd src/client
pnpm install
```

Then rebuild native modules against Electron's Node.js ABI. Standard `pnpm install` compiles native modules (`better-sqlite3`, `libsodium`) against your system Node.js, which uses a different ABI than Electron's embedded Node.js. Without this step, the app will crash on launch with "module version mismatch" errors.

```bash
pnpm run electron-rebuild
# This runs: electron-rebuild -f -w better-sqlite3,sodium-native
```

> **Tip:** Add `"electron-rebuild": "electron-rebuild -f -w better-sqlite3,sodium-native"` to `package.json` scripts, and a `"postinstall": "pnpm run electron-rebuild"` hook so this happens automatically on `pnpm install` for all developers.

If native module rebuilds fail, ensure you have the system dependencies from Step 1 (especially `build-essential` / Xcode CLI tools and Python 3).

---

## Step 6: Running the Development Servers

Open three terminal tabs/panes. The recommended workflow is to start infrastructure, then the server, then the client.

### Terminal 1: Rust Server (with hot-reload)

```bash
cd src/server
export MERCURY_DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury"
export MERCURY_REDIS_URL="redis://localhost:6379"

# cargo-watch recompiles and restarts on any .rs file change
cargo watch -x run
```

First build will take 2-5 minutes (downloading and compiling all dependencies). Subsequent incremental builds take 5-15 seconds.

The server will start on `https://localhost:8443` (API + WebSocket).

### Terminal 2: Electron Client (with hot-reload)

```bash
cd src/client
pnpm dev
```

This starts `electron-vite` in development mode:
- The **Renderer** (React UI) has full Vite HMR — changes to React components reflect instantly.
- The **Main process** and **Worker Thread** are rebuilt and restarted on change (the Electron window will briefly close and reopen).

### Terminal 3: Available for Testing

Use this terminal for running tests, database queries, or tailing logs:

```bash
# Watch server logs with filtering
docker compose logs -f postgres    # Postgres query logs
docker compose logs -f redis       # Redis command logs

# Quick database inspection
docker compose exec postgres psql -U mercury -d mercury
```

### One-Command Alternative

If you prefer a single command that starts everything:

```bash
./scripts/dev.sh
```

This script starts Docker Compose, waits for services to be healthy, runs migrations if needed, and launches both `cargo watch` and `pnpm dev` in the background. Logs are interleaved with color-coded prefixes. Press `Ctrl+C` to stop everything.

---

## Step 7: Verify the Full Stack

Once both the server and client are running:

1. The Electron window should open and display the registration/login screen.
2. Register a test account. The server should log the registration request.
3. After login, the client establishes a WebSocket connection. You should see `identify` and `READY` events in the server logs.
4. Create a test server and a channel. Send a message in a standard channel.

If the WebSocket connection fails, check that:
- The server is running on the port the client expects (check `src/client/src/renderer/config.ts`)
- TLS certificates are trusted (re-run `mkcert -install` if needed)
- No firewall is blocking localhost connections

---

## Editor Setup

### VS Code (Recommended)

The repo includes a `.vscode/settings.json` and `.vscode/extensions.json` with recommended configuration. When you open the project, VS Code will prompt you to install recommended extensions.

**Required extensions:**

| Extension | Purpose |
|-----------|---------|
| `rust-analyzer` | Rust language server (completions, diagnostics, refactoring) |
| `dbaeumer.vscode-eslint` | TypeScript/JavaScript linting |
| `esbenp.prettier-vscode` | Code formatting (TypeScript, JSON, CSS) |
| `bradlc.vscode-tailwindcss` | Tailwind CSS class completions |

**Recommended extensions:**

| Extension | Purpose |
|-----------|---------|
| `vadimcn.vscode-lldb` | Rust debugging (breakpoints, variable inspection) |
| `tamasfe.even-better-toml` | TOML file support (Cargo.toml, config files) |
| `fill-labs.dependi` | Cargo.toml and package.json dependency version checks |

**Key settings (already in `.vscode/settings.json`):**

```jsonc
{
  // Point rust-analyzer at the server workspace
  "rust-analyzer.linkedProjects": ["src/server/Cargo.toml"],
  
  // Format Rust on save
  "rust-analyzer.check.command": "clippy",
  "[rust]": {
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "rust-lang.rust-analyzer"
  },

  // Format TypeScript on save  
  "[typescript]": {
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  },
  "[typescriptreact]": {
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  }
}
```

### Other Editors

- **Neovim:** Use `rust-tools.nvim` or `rustaceanvim` for Rust, and `nvim-lspconfig` with `typescript-language-server` for TypeScript. Point the Rust workspace root to `src/server/`.
- **IntelliJ/CLion:** Use the official Rust plugin. Open `src/server/` as the Rust project root and `src/client/` as the JavaScript project root (or use IntelliJ's monorepo support).

---

## Running Tests

### Server (Rust)

```bash
cd src/server

# Unit tests — cargo nextest runs tests in parallel with better output
cargo nextest run

# Tests that hit the database (requires running Postgres)
# sqlx-cli uses DATABASE_URL (not MERCURY_ prefixed)
export DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury_test"
sqlx database create                    # Create the test database
sqlx migrate run --source migrations/   # Apply migrations
cargo nextest run -- --ignored          # Run DB-dependent tests (marked #[ignore])

# Run clippy (linter) — CI will fail if this produces warnings
cargo clippy --workspace -- -D warnings

# Run with hot-reload during test-driven development
cargo watch -x "nextest run -- my_test_name"

# Note: standard `cargo test` also works but nextest is preferred for 
# parallel execution and better failure output
```

### Client (TypeScript)

```bash
cd src/client

# Unit tests (Vitest — fast, no Electron required)
pnpm test

# Run in watch mode during development
pnpm test:watch

# Integration tests (Worker Thread lifecycle, IPC round-trips)
pnpm test:integration

# E2E tests (Playwright — launches full Electron app, requires running server)
pnpm test:e2e

# Lint and type-check
pnpm lint          # ESLint
pnpm typecheck     # tsc --noEmit
```

### Full-Stack Integration

```bash
# From repo root — starts server, runs client E2E tests against it, tears down
./scripts/test-integration.sh
```

This mirrors the `integration.yml` CI workflow: it spins up infrastructure, builds and starts the server, runs the client's Playwright E2E suite against it, and reports results.

---

## Common Development Tasks

### Reset the Database

```bash
# Wipe everything and re-migrate
./scripts/reset-db.sh

# Or manually:
docker compose exec postgres psql -U mercury -c "DROP DATABASE mercury;"
docker compose exec postgres psql -U mercury -c "CREATE DATABASE mercury;"
cd src/server && sqlx migrate run --source migrations/
```

### Add a New SQL Migration

```bash
cd src/server
sqlx migrate add <description>
# Creates: migrations/<timestamp>_<description>.sql
# Edit the file, then: sqlx migrate run --source migrations/
```

### Rebuild Native Modules (Client)

If you update Electron's version or switch Node.js versions, native modules need rebuilding against the new Electron ABI:

```bash
cd src/client
pnpm run electron-rebuild
# Or manually: npx electron-rebuild -f -w better-sqlite3,sodium-native
```

### Inspect the Encrypted SQLite Databases (Client)

During development, you may need to inspect the client's local databases. They are encrypted with `safeStorage`, so you can't open them with a standard SQLite browser. The client includes a debug utility:

```bash
cd src/client
pnpm run debug:dump-keys     # Prints key store contents (dev builds only)
pnpm run debug:dump-messages  # Prints local E2E message history (dev builds only)
```

These commands are stripped from production builds. They decrypt the databases using the development machine's keychain and print contents to stdout.

### Update Rust Dependencies

```bash
cd src/server
cargo update                  # Update all dependencies within semver bounds
cargo outdated                # Check for major version updates (install: cargo install cargo-outdated)
```

### Update Client Dependencies

```bash
cd src/client
pnpm update                   # Update within semver bounds
pnpm outdated                 # Check for major version updates
pnpm dlx npm-check-updates    # Interactive major version bumps
```

---

## Environment Variables Reference

The `.env.example` file documents all configurable variables. Here are the ones relevant to local development:

| Variable | Default | Description |
|----------|---------|-------------|
| `MERCURY_DATABASE_URL` | `postgres://mercury:mercury@localhost:5432/mercury` | Postgres connection string |
| `MERCURY_REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `MERCURY_AUTH_JWT_SECRET` | `dev-secret-change-in-production` | JWT signing key (`[auth] jwt_secret` in config) |
| `MERCURY_SERVER_HOST` | `0.0.0.0` | Server listen host (`[server] host` in config) |
| `MERCURY_SERVER_PORT` | `8443` | Server listen port (`[server] port` in config) |
| `PUBLIC_DOMAIN` | `localhost` | Public hostname (used for TURN realm, ICE candidates) |
| `TURN_SECRET` | `mercury-turn-dev-secret` | Shared secret for TURN credential generation |
| `RUST_LOG` | `mercury=debug,tower_http=debug` | Server log level ([`tracing` filter syntax](https://docs.rs/tracing-subscriber/latest/tracing_subscriber/filter/struct.EnvFilter.html)) |

---

## Project Structure Quick Reference

```
mercury/
├── docs/                     Architecture docs, protocol specs, operator guide
│   └── protocol/             Wire format specs (JSON/MessagePack envelope, encryption modes, media frames)
├── src/
│   ├── server/               Rust backend (Cargo virtual workspace)
│   │   ├── crates/
│   │   │   ├── mercury-server/   Binary entry point (main.rs, #[global_allocator])
│   │   │   ├── mercury-api/      Axum handlers, WebSocket, middleware
│   │   │   ├── mercury-core/     Domain models, config parsing
│   │   │   ├── mercury-db/       sqlx queries, connection pool
│   │   │   ├── mercury-auth/     Argon2, JWT, TURN credentials
│   │   │   ├── mercury-crypto/   Key bundle validation
│   │   │   └── mercury-media/    SFU, WebRTC signaling, core-pinned runtime
│   │   ├── migrations/           SQL migration files
│   │   └── config/               Server config (default.toml)
│   └── client/               Electron + React frontend
│       └── src/
│           ├── main/             Electron main process (IPC router, safeStorage proxy)
│           ├── preload/          contextBridge API surface
│           ├── renderer/         React + Zustand + Tailwind + WebRTC
│           ├── worker/           Crypto Worker Thread (engine, SQLite stores)
│           └── shared/           Shared TypeScript types (wire format interfaces, op codes, enums)
├── scripts/                  Dev utilities (cert gen, DB reset, dev runner)
├── docker-compose.yml        Local dev infrastructure
└── docker-compose.prod.yml   Production reference deployment
```

---

## Troubleshooting

### `cargo build` fails with OpenSSL errors

Your system is missing OpenSSL development headers.

```bash
# macOS
brew install openssl
export OPENSSL_DIR=$(brew --prefix openssl)

# Ubuntu/Debian
sudo apt install -y libssl-dev pkg-config

# Fedora
sudo dnf5 install -y openssl-devel pkg-config
```

### `pnpm install` fails on `better-sqlite3` or `libsodium`

These are native modules that require compilation. Ensure you have:
- Python 3 (`python3 --version`)
- A C++ compiler (`gcc --version` or `clang --version`)
- `node-gyp` prerequisites: `pnpm add -g node-gyp` then `node-gyp install`

On macOS, if you see "no Xcode or CLT version detected," run `xcode-select --install`.

If the app crashes on launch with "module version mismatch," you need to rebuild native modules against Electron's ABI:

```bash
cd src/client
pnpm run electron-rebuild
```

### Electron window is blank / white screen

The Vite dev server for the renderer may not be ready yet. Check the `pnpm dev` terminal for errors. Common causes:
- Port conflict (another process on port 5173). Kill it or change the port in `electron.vite.config.ts`.
- Missing environment variables. Copy `.env.example` to `.env` in `src/client/` if one exists.

### WebSocket connection refused

- Confirm the server is running (`curl -k https://localhost:8443/health`).
- Check that the client's server URL matches the server's bind address.
- On Linux, ensure `localhost` resolves correctly (`cat /etc/hosts` should have `127.0.0.1 localhost`).

### `safeStorage.isEncryptionAvailable()` returns false on Linux

Your desktop environment's keychain daemon isn't running or isn't detected. Mercury will fall back to the app password prompt — this is expected behavior on minimal window managers. To fix:

```bash
# GNOME-based (Ubuntu, Fedora Workstation, Cinnamon, etc.)
sudo apt install gnome-keyring    # or: sudo dnf5 install gnome-keyring
# Then log out and back in

# KDE Plasma
sudo apt install kwalletmanager   # or: sudo dnf5 install kwalletmanager
```

If running in a headless environment or CI, set:
```bash
export MERCURY_DEV_UNSAFE_KEY_STORAGE=1
```
This allows unencrypted key storage in dev builds only. This flag is ignored in production builds.

### Docker Compose services won't start

```bash
# Check what's using the ports
sudo lsof -i :5432    # Postgres
sudo lsof -i :6379    # Redis
sudo lsof -i :3478    # TURN

# If a local Postgres or Redis is running, stop it:
sudo systemctl stop postgresql redis
# Or change the port mappings in docker-compose.yml
```

### Rust incremental compilation is slow

If incremental builds take more than 15 seconds:
- Install `lld` (the LLVM linker) — see Step 2.
- On macOS with Apple Silicon, ensure you're using the `aarch64-apple-darwin` target (not Rosetta).
- Set `CARGO_INCREMENTAL=1` (should be default, but verify).
- Consider `sccache` for shared compilation caching: `cargo install sccache && export RUSTC_WRAPPER=sccache`.

---

## Next Steps

Once your environment is running:

1. Read `docs/architecture/` for a high-level understanding of the system.
2. Read `docs/protocol/` for the wire format definitions (JSON/MessagePack envelope, encryption modes, media frame layout).
3. Pick a crate or component to work on — `mercury-api` and `src/client/src/renderer` are good starting points for most features.
4. Run the test suites before submitting a PR. CI runs `cargo clippy`, `cargo test`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` — your PR will be blocked if any of these fail.
