#!/usr/bin/env bash
# Rebuilds better-sqlite3 for system Node.js, runs vitest, then rebuilds
# for Electron so `pnpm dev` continues to work.
#
# Usage:  bash scripts/test-native.sh [vitest args...]
# Example: bash scripts/test-native.sh tests/unit/store/

set -uo pipefail

SQLITE_DIR=$(node -e "console.log(require('path').dirname(require.resolve('better-sqlite3/package.json')))")

echo "→ Rebuilding better-sqlite3 for Node.js $(node --version)…"
(cd "$SQLITE_DIR" && npx node-gyp rebuild 2>&1 | tail -1)

echo "→ Running vitest…"
EXIT=0
npx vitest run "$@" || EXIT=$?

echo "→ Rebuilding better-sqlite3 for Electron…"
npx electron-rebuild -f -w better-sqlite3 2>&1 | tail -1

exit $EXIT
