#!/usr/bin/env bash
#
# dev.sh — One-command Mercury local development environment.
#
# Starts Docker Compose infrastructure, waits for services, runs migrations,
# and launches both the Rust server (cargo watch) and Electron client (pnpm dev).
#
# Logs are interleaved with color-coded prefixes. Press Ctrl+C to stop everything.
#
# Prerequisites:
#   - Docker and Docker Compose
#   - Rust toolchain with cargo-watch
#   - Node.js 24+ with pnpm
#   - sqlx-cli
#   - Local TLS certs (run ./scripts/generate-certs.sh first)
#
# Usage:
#   ./scripts/dev.sh                  # Start everything
#   ./scripts/dev.sh --skip-client    # Server only (useful for backend work)
#   ./scripts/dev.sh --skip-server    # Client only (useful for frontend work)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/src/server"
CLIENT_DIR="$REPO_ROOT/src/client"
MIGRATIONS_DIR="$SERVER_DIR/migrations"

# ── Parse arguments ──────────────────────────────────────────────────────────

SKIP_CLIENT=false
SKIP_SERVER=false

for arg in "$@"; do
    case "$arg" in
        --skip-client) SKIP_CLIENT=true ;;
        --skip-server) SKIP_SERVER=true ;;
        --help|-h)
            echo "Usage: $0 [--skip-client] [--skip-server]"
            exit 0
            ;;
    esac
done

# ── Colors for log prefixes ──────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'  # No color

prefix_output() {
    local prefix="$1"
    local color="$2"
    while IFS= read -r line; do
        echo -e "${color}[${prefix}]${NC} $line"
    done
}

# ── Track child PIDs for cleanup ─────────────────────────────────────────────

PIDS=()

cleanup() {
    echo ""
    echo -e "${YELLOW}==> Shutting down...${NC}"

    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done

    # Wait briefly for graceful shutdown
    sleep 1

    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    done

    echo -e "${YELLOW}==> Stopping Docker services...${NC}"
    docker compose -f "$REPO_ROOT/docker-compose.yml" stop 2>/dev/null || true

    echo -e "${GREEN}==> Shutdown complete.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# ── Preflight checks ────────────────────────────────────────────────────────

echo -e "${CYAN}==> Checking prerequisites...${NC}"

missing=()
command -v docker &>/dev/null || missing+=("docker")
command -v cargo  &>/dev/null || missing+=("cargo (rustup)")

if [[ "$SKIP_SERVER" == false ]]; then
    command -v cargo-watch &>/dev/null || missing+=("cargo-watch")
    command -v sqlx        &>/dev/null || missing+=("sqlx-cli")
fi

if [[ "$SKIP_CLIENT" == false ]]; then
    command -v node &>/dev/null || missing+=("node (nvm)")
    command -v pnpm &>/dev/null || missing+=("pnpm")
fi

if [[ ${#missing[@]} -gt 0 ]]; then
    echo -e "${RED}ERROR: Missing required tools: ${missing[*]}${NC}"
    echo "See GETTING_STARTED.md for installation instructions."
    exit 1
fi

# Check for TLS certs
if [[ ! -f "$REPO_ROOT/certs/cert.pem" ]]; then
    echo -e "${RED}ERROR: TLS certificates not found.${NC}"
    echo "Run: ./scripts/generate-certs.sh"
    exit 1
fi

# ── Start infrastructure ─────────────────────────────────────────────────────

echo -e "${CYAN}==> Starting Docker Compose services...${NC}"
docker compose -f "$REPO_ROOT/docker-compose.yml" up -d

# ── Wait for Postgres ────────────────────────────────────────────────────────

echo -e "${CYAN}==> Waiting for Postgres...${NC}"
retries=0
max_retries=30
until docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres pg_isready -U mercury &>/dev/null; do
    retries=$((retries + 1))
    if [[ $retries -ge $max_retries ]]; then
        echo -e "${RED}ERROR: Postgres failed to start after ${max_retries}s${NC}"
        exit 1
    fi
    sleep 1
done
echo -e "${GREEN}==> Postgres is ready.${NC}"

# ── Wait for Redis ───────────────────────────────────────────────────────────

echo -e "${CYAN}==> Waiting for Redis...${NC}"
retries=0
until docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T redis redis-cli ping &>/dev/null; do
    retries=$((retries + 1))
    if [[ $retries -ge $max_retries ]]; then
        echo -e "${RED}ERROR: Redis failed to start after ${max_retries}s${NC}"
        exit 1
    fi
    sleep 1
done
echo -e "${GREEN}==> Redis is ready.${NC}"

# ── Run migrations ───────────────────────────────────────────────────────────

export DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury"

echo -e "${CYAN}==> Ensuring database exists...${NC}"
docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
    psql -U mercury -tc "SELECT 1 FROM pg_database WHERE datname = 'mercury'" \
    | grep -q 1 || \
    docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
    psql -U mercury -c "CREATE DATABASE mercury;"

echo -e "${CYAN}==> Running migrations...${NC}"
(cd "$SERVER_DIR" && sqlx migrate run --source "$MIGRATIONS_DIR") 2>&1 \
    | prefix_output "migrate" "$YELLOW"
echo -e "${GREEN}==> Migrations complete.${NC}"

# ── Start server ─────────────────────────────────────────────────────────────

if [[ "$SKIP_SERVER" == false ]]; then
    echo -e "${CYAN}==> Starting Rust server (cargo watch)...${NC}"
    export MERCURY_DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury"
    export MERCURY_REDIS_URL="redis://localhost:6379"
    export RUST_LOG="${RUST_LOG:-mercury=debug,tower_http=debug}"

    (cd "$SERVER_DIR" && cargo watch -x run 2>&1) \
        | prefix_output "server" "$GREEN" &
    PIDS+=($!)

    # Give the server a moment to start compiling
    sleep 2
fi

# ── Start client ─────────────────────────────────────────────────────────────

if [[ "$SKIP_CLIENT" == false ]]; then
    echo -e "${CYAN}==> Starting Electron client (pnpm dev)...${NC}"

    (cd "$CLIENT_DIR" && pnpm dev 2>&1) \
        | prefix_output "client" "$BLUE" &
    PIDS+=($!)
fi

# ── Running ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Mercury development environment is running.${NC}"
echo -e "${GREEN}${NC}"
echo -e "${GREEN}  Server:  https://localhost:8443  (health: /health)${NC}"
echo -e "${GREEN}  Client:  Electron window${NC}"
echo -e "${GREEN}${NC}"
echo -e "${GREEN}  Press Ctrl+C to stop everything.${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""

# Wait for any child to exit (or Ctrl+C)
wait
