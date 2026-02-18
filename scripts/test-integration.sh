#!/usr/bin/env bash
#
# test-integration.sh — Full-stack integration test runner.
#
# Mirrors the integration.yml CI workflow:
#   1. Start Docker Compose infrastructure
#   2. Run database migrations
#   3. Build and start the Rust server
#   4. Run client Playwright E2E tests against it
#   5. Tear everything down and report results
#
# Usage:
#   ./scripts/test-integration.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/src/server"
CLIENT_DIR="$REPO_ROOT/src/client"
MIGRATIONS_DIR="$SERVER_DIR/migrations"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SERVER_PID=""
EXIT_CODE=0

# ── Cleanup on exit ──────────────────────────────────────────────────────────

cleanup() {
    echo ""
    echo -e "${YELLOW}==> Tearing down...${NC}"

    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi

    docker compose -f "$REPO_ROOT/docker-compose.yml" down -v 2>/dev/null || true

    echo ""
    if [[ $EXIT_CODE -eq 0 ]]; then
        echo -e "${GREEN}══════════════════════════════════════${NC}"
        echo -e "${GREEN}  Integration tests PASSED${NC}"
        echo -e "${GREEN}══════════════════════════════════════${NC}"
    else
        echo -e "${RED}══════════════════════════════════════${NC}"
        echo -e "${RED}  Integration tests FAILED${NC}"
        echo -e "${RED}══════════════════════════════════════${NC}"
    fi

    exit $EXIT_CODE
}

trap cleanup EXIT SIGINT SIGTERM

# ── Start infrastructure ─────────────────────────────────────────────────────

echo -e "${CYAN}==> [1/5] Starting infrastructure...${NC}"
docker compose -f "$REPO_ROOT/docker-compose.yml" up -d

# Wait for Postgres
retries=0
until docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres pg_isready -U mercury &>/dev/null; do
    retries=$((retries + 1))
    if [[ $retries -ge 30 ]]; then
        echo -e "${RED}ERROR: Postgres failed to start${NC}"
        EXIT_CODE=1
        exit 1
    fi
    sleep 1
done

# Wait for Redis
retries=0
until docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T redis redis-cli ping &>/dev/null; do
    retries=$((retries + 1))
    if [[ $retries -ge 30 ]]; then
        echo -e "${RED}ERROR: Redis failed to start${NC}"
        EXIT_CODE=1
        exit 1
    fi
    sleep 1
done

echo -e "${GREEN}==> Infrastructure ready.${NC}"

# ── Run migrations ───────────────────────────────────────────────────────────

echo -e "${CYAN}==> [2/5] Running migrations...${NC}"
export DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury"

docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
    psql -U mercury -tc "SELECT 1 FROM pg_database WHERE datname = 'mercury'" \
    | grep -q 1 || \
    docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
    psql -U mercury -c "CREATE DATABASE mercury;"

(cd "$SERVER_DIR" && sqlx migrate run --source "$MIGRATIONS_DIR")
echo -e "${GREEN}==> Migrations complete.${NC}"

# ── Build and start server ───────────────────────────────────────────────────

echo -e "${CYAN}==> [3/5] Building server (release)...${NC}"
(cd "$SERVER_DIR" && cargo build --release)

echo -e "${CYAN}==> [4/5] Starting server...${NC}"
export MERCURY_DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury"
export MERCURY_REDIS_URL="redis://localhost:6379"
export MERCURY_TLS_CERT_PATH="$REPO_ROOT/certs/cert.pem"
export MERCURY_TLS_KEY_PATH="$REPO_ROOT/certs/key.pem"
export RUST_LOG="mercury=info"

(cd "$SERVER_DIR" && cargo run --release) &
SERVER_PID=$!

# Wait for server health check
echo -n "    Waiting for server..."
retries=0
until curl -sk https://localhost:8443/health &>/dev/null; do
    retries=$((retries + 1))
    if [[ $retries -ge 60 ]]; then
        echo ""
        echo -e "${RED}ERROR: Server failed to start within 60s${NC}"
        EXIT_CODE=1
        exit 1
    fi
    echo -n "."
    sleep 1
done
echo ""
echo -e "${GREEN}==> Server is ready.${NC}"

# ── Run E2E tests ────────────────────────────────────────────────────────────

echo -e "${CYAN}==> [5/5] Running Playwright E2E tests...${NC}"
(cd "$CLIENT_DIR" && pnpm test:e2e) || EXIT_CODE=$?
