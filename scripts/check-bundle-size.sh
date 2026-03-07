#!/usr/bin/env bash
# Check the unpacked bundle size of the Mercury client.
# Target: < 200 MB unpacked.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIENT_DIR="$SCRIPT_DIR/../src/client"
TARGET_MB=200

echo "=== Mercury Bundle Size Check ==="

cd "$CLIENT_DIR"

# Build the client
echo "Building client..."
pnpm run build 2>&1 | tail -5

# Check if dist/ exists
if [ ! -d "out" ] && [ ! -d "dist" ]; then
  echo "ERROR: Neither out/ nor dist/ directory found after build."
  exit 1
fi

# electron-vite outputs to out/
BUILD_DIR="out"
if [ ! -d "$BUILD_DIR" ]; then
  BUILD_DIR="dist"
fi

# Measure unpacked size in bytes
SIZE_BYTES=$(du -sb "$BUILD_DIR" | cut -f1)
SIZE_MB=$((SIZE_BYTES / 1048576))

echo ""
echo "Build directory: $BUILD_DIR"
echo "Unpacked size: ${SIZE_MB} MB (${SIZE_BYTES} bytes)"
echo "Target: < ${TARGET_MB} MB"
echo ""

if [ "$SIZE_MB" -lt "$TARGET_MB" ]; then
  echo "[PASS] Bundle size ${SIZE_MB} MB is under ${TARGET_MB} MB target."
  exit 0
else
  echo "[FAIL] Bundle size ${SIZE_MB} MB exceeds ${TARGET_MB} MB target!"
  echo ""
  echo "Largest directories:"
  du -sh "$BUILD_DIR"/*/ 2>/dev/null | sort -rh | head -10
  exit 1
fi
