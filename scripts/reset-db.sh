#!/usr/bin/env bash
#
# reset-db.sh — Wipe and recreate the Mercury development database.
#
# Drops the mercury database, recreates it, and runs all migrations.
# Optionally resets the test database too.
#
# Prerequisites:
#   - Docker Compose services running (docker compose up -d)
#   - sqlx-cli installed (cargo install sqlx-cli --features postgres)
#
# Usage:
#   ./scripts/reset-db.sh            # Reset dev database only
#   ./scripts/reset-db.sh --test     # Also reset test database
#   ./scripts/reset-db.sh --all      # Reset both dev and test databases
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/src/server"
MIGRATIONS_DIR="$SERVER_DIR/migrations"

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-mercury}"
DB_PASSWORD="${DB_PASSWORD:-mercury}"
DB_NAME="mercury"
DB_NAME_TEST="mercury_test"

RESET_TEST=false
MODE="${1:-}"

if [[ "$MODE" == "--test" ]]; then
    RESET_TEST=true
    DB_NAME=""  # skip dev database
elif [[ "$MODE" == "--all" ]]; then
    RESET_TEST=true
fi

# ── Preflight checks ────────────────────────────────────────────────────────

if ! command -v sqlx &> /dev/null; then
    echo "ERROR: sqlx-cli is not installed."
    echo "Run: cargo install sqlx-cli --features postgres"
    exit 1
fi

# Verify Postgres is reachable
if ! docker compose exec -T postgres pg_isready -U "$DB_USER" &> /dev/null; then
    echo "ERROR: Postgres is not running."
    echo "Run: docker compose up -d"
    exit 1
fi

# ── Helper function ──────────────────────────────────────────────────────────

reset_database() {
    local db_name="$1"
    local db_url="postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${db_name}"

    echo "==> Dropping database: $db_name"
    docker compose exec -T postgres psql -U "$DB_USER" -c \
        "DROP DATABASE IF EXISTS ${db_name};" 2>/dev/null || true

    echo "==> Creating database: $db_name"
    docker compose exec -T postgres psql -U "$DB_USER" -c \
        "CREATE DATABASE ${db_name};"

    echo "==> Running migrations on: $db_name"
    DATABASE_URL="$db_url" sqlx migrate run --source "$MIGRATIONS_DIR"

    echo "==> ✓ $db_name reset complete"
    echo ""
}

# ── Execute ──────────────────────────────────────────────────────────────────

echo ""

if [[ -n "$DB_NAME" ]]; then
    reset_database "$DB_NAME"
fi

if [[ "$RESET_TEST" == true ]]; then
    reset_database "$DB_NAME_TEST"
fi

# ── Flush Redis (optional but keeps state consistent) ────────────────────────

echo "==> Flushing Redis..."
docker compose exec -T redis redis-cli FLUSHALL > /dev/null 2>&1 || true
echo "==> ✓ Redis flushed"
echo ""

echo "Done. Database(s) reset and migrations applied."
