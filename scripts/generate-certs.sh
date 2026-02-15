#!/usr/bin/env bash
#
# generate-certs.sh — Generate locally-trusted TLS certificates for Mercury development.
#
# Uses mkcert to create certificates trusted by the local system, so Electron,
# browsers, and coturn all work without certificate warnings.
#
# Prerequisites: mkcert (https://github.com/FiloSottile/mkcert)
#   macOS:  brew install mkcert
#   Ubuntu: see GETTING_STARTED.md for install instructions
#   Fedora: see GETTING_STARTED.md for install instructions
#
# Usage:
#   ./scripts/generate-certs.sh
#   ./scripts/generate-certs.sh --domain my.server.com
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CERTS_DIR="$REPO_ROOT/certs"

# Allow overriding the domain for non-localhost setups
DOMAIN="${1:-}"
if [[ "$DOMAIN" == "--domain" ]]; then
    DOMAIN="${2:-}"
fi

# ── Preflight checks ────────────────────────────────────────────────────────

if ! command -v mkcert &> /dev/null; then
    echo "ERROR: mkcert is not installed."
    echo ""
    echo "Install it first:"
    echo "  macOS:   brew install mkcert"
    echo "  Ubuntu:  See GETTING_STARTED.md"
    echo "  Fedora:  See GETTING_STARTED.md"
    exit 1
fi

# ── Install local CA (idempotent — safe to run multiple times) ───────────────

echo "==> Ensuring local CA is installed..."
mkcert -install 2>/dev/null || true

# ── Generate certificates ────────────────────────────────────────────────────

mkdir -p "$CERTS_DIR"

# Build the list of SANs (Subject Alternative Names)
SANS=("localhost" "127.0.0.1" "::1")
if [[ -n "$DOMAIN" ]]; then
    SANS+=("$DOMAIN")
    echo "==> Generating certificates for: ${SANS[*]}"
else
    echo "==> Generating certificates for: ${SANS[*]}"
    echo "    (use --domain <hostname> to add a public domain)"
fi

mkcert \
    -cert-file "$CERTS_DIR/cert.pem" \
    -key-file "$CERTS_DIR/key.pem" \
    "${SANS[@]}"

# ── Set permissions ──────────────────────────────────────────────────────────

chmod 644 "$CERTS_DIR/cert.pem"
chmod 600 "$CERTS_DIR/key.pem"

# ── Verify ───────────────────────────────────────────────────────────────────

echo ""
echo "==> Certificates generated:"
echo "    Certificate: $CERTS_DIR/cert.pem"
echo "    Private key: $CERTS_DIR/key.pem"
echo ""
echo "    SANs: ${SANS[*]}"
echo "    Expires: $(openssl x509 -in "$CERTS_DIR/cert.pem" -noout -enddate 2>/dev/null | cut -d= -f2)"
echo ""
echo "==> These are used by:"
echo "    • Mercury server (native):  reads from ./certs/"
echo "    • coturn (Docker):          mounted via docker-compose.yml"
echo ""
echo "Done. Certificates are locally trusted by your system."
