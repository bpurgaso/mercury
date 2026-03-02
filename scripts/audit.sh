#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Mercury — Security Audit Script
# ─────────────────────────────────────────────────────────────────────────────
# Runs dependency vulnerability audits for both Rust and Node.js dependencies.
#
# Usage:
#   ./scripts/audit.sh
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

EXIT_CODE=0

echo "==> Mercury Security Audit"
echo

# ── Rust Dependency Audit ────────────────────────────────────────────────────
echo "==> Running cargo audit..."
if command -v cargo-audit &> /dev/null; then
    (cd "$ROOT_DIR/src/server" && cargo audit) || EXIT_CODE=1
else
    echo "WARNING: cargo-audit not installed. Install with: cargo install cargo-audit"
    EXIT_CODE=1
fi

echo

# ── Node.js Dependency Audit ────────────────────────────────────────────────
if [ -f "$ROOT_DIR/pnpm-lock.yaml" ]; then
    echo "==> Running pnpm audit..."
    if command -v pnpm &> /dev/null; then
        (cd "$ROOT_DIR" && pnpm audit) || EXIT_CODE=1
    else
        echo "WARNING: pnpm not installed."
    fi
elif [ -f "$ROOT_DIR/package-lock.json" ]; then
    echo "==> Running npm audit..."
    (cd "$ROOT_DIR" && npm audit) || EXIT_CODE=1
fi

echo
if [ $EXIT_CODE -eq 0 ]; then
    echo "==> All audits passed."
else
    echo "==> Audit found issues. Review the output above."
fi

exit $EXIT_CODE
