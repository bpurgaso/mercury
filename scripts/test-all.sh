#!/usr/bin/env bash
#
# test-all.sh — Start infrastructure, run all tests, shut everything down.
#
# What it does:
#   1. Start Docker Compose (Postgres, Redis, coturn)
#   2. Wait for Postgres and Redis to be healthy
#   3. Create mercury_test database and run migrations
#   4. Run server tests (cargo nextest)
#   5. Run client unit tests (vitest)
#   6. Optionally build + start server and run client E2E tests (Playwright)
#   7. Tear everything down and report results
#
# Usage:
#   ./scripts/test-all.sh              # Server tests + client unit tests
#   ./scripts/test-all.sh --e2e        # Also run E2E tests (slower)
#   ./scripts/test-all.sh --no-infra   # Skip Docker (infra already running)
#
# Prerequisites:
#   - Docker and Docker Compose
#   - Rust toolchain with cargo-nextest
#   - Node.js 24+ with pnpm
#   - sqlx-cli (cargo install sqlx-cli --features postgres)
#   - TLS certs for E2E (run ./scripts/generate-certs.sh)
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/src/server"
CLIENT_DIR="$REPO_ROOT/src/client"
MIGRATIONS_DIR="$SERVER_DIR/migrations"

# ── Colors ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Parse arguments ──────────────────────────────────────────────────────────

RUN_E2E=false
MANAGE_INFRA=true

for arg in "$@"; do
    case "$arg" in
        --e2e)       RUN_E2E=true ;;
        --no-infra)  MANAGE_INFRA=false ;;
        --help|-h)
            echo "Usage: $0 [--e2e] [--no-infra]"
            echo ""
            echo "  --e2e       Also run E2E tests (builds server, starts it, runs Playwright)"
            echo "  --no-infra  Skip starting/stopping Docker (assumes infra is already running)"
            exit 0
            ;;
    esac
done

# ── State tracking ───────────────────────────────────────────────────────────

SERVER_PID=""
STARTED_INFRA=false
RESULTS=()  # Array of "PASS|FAIL suite_name"
EXIT_CODE=0

# ── Cleanup on exit ──────────────────────────────────────────────────────────

cleanup() {
    echo ""
    echo -e "${YELLOW}==> Tearing down...${NC}"

    # Stop the server if we started it
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi

    # Stop Docker if we started it
    if [[ "$STARTED_INFRA" == true ]]; then
        echo -e "${YELLOW}    Stopping Docker services...${NC}"
        docker compose -f "$REPO_ROOT/docker-compose.yml" down -v 2>/dev/null || true
    fi

    # ── Results summary ──────────────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}══════════════════════════════════════════${NC}"
    echo -e "${BOLD}  Test Results${NC}"
    echo -e "${BOLD}══════════════════════════════════════════${NC}"

    if [[ ${#RESULTS[@]} -eq 0 ]]; then
        echo -e "  ${YELLOW}No tests were run.${NC}"
    else
        for result in "${RESULTS[@]}"; do
            status="${result%%|*}"
            suite="${result#*|}"
            if [[ "$status" == "PASS" ]]; then
                echo -e "  ${GREEN}✓ PASS${NC}  $suite"
            else
                echo -e "  ${RED}✗ FAIL${NC}  $suite"
            fi
        done
    fi

    echo -e "${BOLD}══════════════════════════════════════════${NC}"

    if [[ $EXIT_CODE -eq 0 ]]; then
        echo -e "${GREEN}  All tests passed.${NC}"
    else
        echo -e "${RED}  Some tests failed.${NC}"
    fi

    echo -e "${BOLD}══════════════════════════════════════════${NC}"
    echo ""

    exit $EXIT_CODE
}

trap cleanup EXIT SIGINT SIGTERM

# ── Preflight checks ────────────────────────────────────────────────────────

echo -e "${CYAN}==> Checking prerequisites...${NC}"

missing=()
command -v cargo       &>/dev/null || missing+=("cargo")
command -v cargo-nextest &>/dev/null || { command -v cargo &>/dev/null && cargo nextest --version &>/dev/null 2>&1 || missing+=("cargo-nextest"); }
command -v node        &>/dev/null || missing+=("node")
command -v pnpm        &>/dev/null || missing+=("pnpm")
command -v sqlx        &>/dev/null || missing+=("sqlx-cli")

if [[ "$MANAGE_INFRA" == true ]]; then
    command -v docker  &>/dev/null || missing+=("docker")
fi

if [[ ${#missing[@]} -gt 0 ]]; then
    echo -e "${RED}ERROR: Missing required tools: ${missing[*]}${NC}"
    echo "See docs/GETTING_STARTED.md for installation instructions."
    exit 1
fi

# ── Step 1: Start infrastructure ─────────────────────────────────────────────

STEP=1
TOTAL_STEPS=4
if [[ "$RUN_E2E" == true ]]; then
    TOTAL_STEPS=6
fi

if [[ "$MANAGE_INFRA" == true ]]; then
    echo -e "${CYAN}==> [$STEP/$TOTAL_STEPS] Starting Docker infrastructure...${NC}"
    docker compose -f "$REPO_ROOT/docker-compose.yml" up -d
    STARTED_INFRA=true

    # Wait for Postgres
    echo -n "    Waiting for Postgres"
    retries=0
    until docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres pg_isready -U mercury &>/dev/null; do
        retries=$((retries + 1))
        if [[ $retries -ge 30 ]]; then
            echo ""
            echo -e "${RED}ERROR: Postgres failed to start after 30s${NC}"
            EXIT_CODE=1; exit 1
        fi
        echo -n "."
        sleep 1
    done
    echo -e " ${GREEN}ready${NC}"

    # Wait for Redis
    echo -n "    Waiting for Redis"
    retries=0
    until docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T redis redis-cli ping &>/dev/null; do
        retries=$((retries + 1))
        if [[ $retries -ge 30 ]]; then
            echo ""
            echo -e "${RED}ERROR: Redis failed to start after 30s${NC}"
            EXIT_CODE=1; exit 1
        fi
        echo -n "."
        sleep 1
    done
    echo -e " ${GREEN}ready${NC}"
else
    echo -e "${CYAN}==> [$STEP/$TOTAL_STEPS] Skipping infrastructure (--no-infra)${NC}"
fi

# ── Step 2: Database setup ───────────────────────────────────────────────────

STEP=$((STEP + 1))
echo -e "${CYAN}==> [$STEP/$TOTAL_STEPS] Setting up test database...${NC}"

# Create mercury_test database if it doesn't exist
docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
    psql -U mercury -tc "SELECT 1 FROM pg_database WHERE datname = 'mercury_test'" \
    | grep -q 1 || \
    docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
    psql -U mercury -c "CREATE DATABASE mercury_test;"

# Run migrations on test database
export DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury_test"
(cd "$SERVER_DIR" && sqlx migrate run --source "$MIGRATIONS_DIR") 2>&1 | tail -1
echo -e "${GREEN}    Test database ready.${NC}"

# If running E2E tests, also set up the main database
if [[ "$RUN_E2E" == true ]]; then
    docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
        psql -U mercury -tc "SELECT 1 FROM pg_database WHERE datname = 'mercury'" \
        | grep -q 1 || \
        docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
        psql -U mercury -c "CREATE DATABASE mercury;"

    (cd "$SERVER_DIR" && DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury" \
        sqlx migrate run --source "$MIGRATIONS_DIR") 2>&1 | tail -1
    echo -e "${GREEN}    Main database ready.${NC}"
fi

# ── Step 3: Server tests ────────────────────────────────────────────────────

STEP=$((STEP + 1))
echo ""
echo -e "${CYAN}==> [$STEP/$TOTAL_STEPS] Running server tests (cargo nextest)...${NC}"
echo ""

if (cd "$SERVER_DIR" && DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury_test" cargo nextest run -j 1); then
    RESULTS+=("PASS|Server tests (cargo nextest)")
else
    RESULTS+=("FAIL|Server tests (cargo nextest)")
    EXIT_CODE=1
fi

# ── Step 4: Client unit tests ───────────────────────────────────────────────

STEP=$((STEP + 1))
echo ""
echo -e "${CYAN}==> [$STEP/$TOTAL_STEPS] Running client unit tests (vitest)...${NC}"
echo ""

if (cd "$CLIENT_DIR" && pnpm test); then
    RESULTS+=("PASS|Client unit tests (vitest)")
else
    RESULTS+=("FAIL|Client unit tests (vitest)")
    EXIT_CODE=1
fi

# ── Step 5–6: E2E tests (optional) ──────────────────────────────────────────

if [[ "$RUN_E2E" == true ]]; then
    # Step 5: Build and start server
    STEP=$((STEP + 1))
    echo ""
    echo -e "${CYAN}==> [$STEP/$TOTAL_STEPS] Building and starting server for E2E...${NC}"

    # Check for TLS certs
    if [[ ! -f "$REPO_ROOT/certs/cert.pem" ]]; then
        echo -e "${YELLOW}    TLS certs not found, generating...${NC}"
        "$REPO_ROOT/scripts/generate-certs.sh"
    fi

    (cd "$SERVER_DIR" && cargo build --release)

    export MERCURY_DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury"
    export MERCURY_REDIS_URL="redis://localhost:6379"
    export MERCURY_TLS_CERT_PATH="$REPO_ROOT/certs/cert.pem"
    export MERCURY_TLS_KEY_PATH="$REPO_ROOT/certs/key.pem"
    export RUST_LOG="mercury=info"

    (cd "$SERVER_DIR" && cargo run --release) &
    SERVER_PID=$!

    echo -n "    Waiting for server"
    retries=0
    until curl -sk https://localhost:8443/health &>/dev/null; do
        retries=$((retries + 1))
        if [[ $retries -ge 60 ]]; then
            echo ""
            echo -e "${RED}ERROR: Server failed to start within 60s${NC}"
            RESULTS+=("FAIL|E2E tests (server failed to start)")
            EXIT_CODE=1
            exit 1
        fi
        echo -n "."
        sleep 1
    done
    echo -e " ${GREEN}ready${NC}"

    # Step 6: Run E2E tests
    STEP=$((STEP + 1))
    echo ""
    echo -e "${CYAN}==> [$STEP/$TOTAL_STEPS] Running E2E tests (Playwright)...${NC}"
    echo ""

    if (cd "$CLIENT_DIR" && pnpm test:e2e); then
        RESULTS+=("PASS|E2E tests (Playwright)")
    else
        RESULTS+=("FAIL|E2E tests (Playwright)")
        EXIT_CODE=1
    fi
fi
