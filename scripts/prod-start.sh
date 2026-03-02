#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Mercury — Production Start Script
# ─────────────────────────────────────────────────────────────────────────────
# Validates configuration and starts the production Docker Compose stack.
#
# Usage:
#   ./scripts/prod-start.sh
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Mercury Production Startup"

# ── Check .env file ──────────────────────────────────────────────────────────
if [ ! -f "$ROOT_DIR/.env" ]; then
    echo "ERROR: .env file not found. Copy .env.example and configure it:"
    echo "  cp .env.example .env"
    exit 1
fi

# Source .env for validation
set -a
source "$ROOT_DIR/.env"
set +a

# ── Validate required environment variables ──────────────────────────────────
REQUIRED_VARS=(
    MERCURY_AUTH_JWT_SECRET
    TURN_SECRET
    POSTGRES_PASSWORD
)

for var in "${REQUIRED_VARS[@]}"; do
    val="${!var:-}"
    if [ -z "$val" ]; then
        echo "ERROR: Required environment variable $var is not set in .env"
        exit 1
    fi
    # Warn if still using default/dev values
    if [[ "$val" == *"dev"* ]] || [[ "$val" == *"change"* ]]; then
        echo "WARNING: $var appears to be a development value. Change it for production."
    fi
done

# ── Check TLS certificates ──────────────────────────────────────────────────
CERT_PATH="${MERCURY_TLS_CERT_PATH:-./certs/cert.pem}"
KEY_PATH="${MERCURY_TLS_KEY_PATH:-./certs/key.pem}"

if [ ! -f "$ROOT_DIR/$CERT_PATH" ] || [ ! -f "$ROOT_DIR/$KEY_PATH" ]; then
    echo "ERROR: TLS certificates not found at $CERT_PATH / $KEY_PATH"
    echo "  Generate dev certs: ./scripts/generate-certs.sh"
    echo "  For production, use proper certificates."
    exit 1
fi

echo "==> Configuration validated"

# ── Build and start ──────────────────────────────────────────────────────────
cd "$ROOT_DIR"

echo "==> Building Docker images..."
docker compose -f docker-compose.prod.yml build

echo "==> Starting services..."
docker compose -f docker-compose.prod.yml up -d

# ── Wait for health check ───────────────────────────────────────────────────
echo "==> Waiting for Mercury to become healthy..."
MAX_WAIT=60
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
    if docker compose -f docker-compose.prod.yml exec -T mercury curl -sf http://localhost:8443/health > /dev/null 2>&1; then
        echo "==> Mercury is healthy!"
        docker compose -f docker-compose.prod.yml exec -T mercury curl -s http://localhost:8443/health | head -c 500
        echo
        exit 0
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
    echo "  Waiting... (${ELAPSED}s / ${MAX_WAIT}s)"
done

echo "WARNING: Mercury did not become healthy within ${MAX_WAIT}s"
echo "Check logs: docker compose -f docker-compose.prod.yml logs mercury"
exit 1
