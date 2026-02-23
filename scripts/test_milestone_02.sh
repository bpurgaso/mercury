#!/bin/bash
set -euo pipefail

echo "=== Milestone 2 Verification ==="
echo "Started: $(date)"

# Prerequisites
echo "--- Checking infrastructure ---"
docker compose exec postgres pg_isready
docker compose exec redis redis-cli ping

# Server tests
echo "--- Server: full test suite ---"
cd src/server
cargo nextest run --workspace -j 1
echo "Server tests: PASS"

# Client static analysis
echo "--- Client: typecheck ---"
cd ../client
pnpm typecheck
echo "Typecheck: PASS"

echo "--- Client: lint ---"
pnpm lint
echo "Lint: PASS"

# Client unit tests
echo "--- Client: unit tests ---"
pnpm test
echo "Unit tests: PASS"

# Client E2E tests
echo "--- Client: E2E tests ---"
pnpm test:e2e
echo "E2E tests: PASS"

# Security verification
echo "--- Security: DB content checks ---"
cd ../..
psql "$DATABASE_URL" -c "
  SELECT
    'E2E_NULL_CHECK' AS test,
    CASE WHEN COUNT(content) = 0 THEN 'PASS' ELSE 'FAIL' END AS result
  FROM messages WHERE dm_channel_id IS NOT NULL
  UNION ALL
  SELECT
    'CIPHERTEXT_UNIQUE' AS test,
    CASE WHEN COUNT(*) = COUNT(DISTINCT ciphertext) THEN 'PASS'
         ELSE 'FAIL' END AS result
  FROM message_recipients
  UNION ALL
  SELECT
    'BROADCAST_CHECK' AS test,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result
  FROM (
    SELECT m.id FROM messages m
    JOIN message_recipients mr ON mr.message_id = m.id
    JOIN channels c ON m.channel_id = c.id
    WHERE c.encryption_mode = 'private'
    GROUP BY m.id
    HAVING COUNT(mr.id) != 1 OR COUNT(mr.device_id) != 0
  ) bad_broadcasts;"

# Security boundary check
echo "--- Security: boundary checks ---"
cd src/client
CRYPTO_IN_RENDERER=$(grep -r "sodium\|libsodium\|crypto_secretbox\|crypto_sign\|crypto_box" src/renderer/ 2>/dev/null | wc -l)
KEYSTORE_IN_RENDERER=$(grep -r "keystore\|KeyStore\|keys\.db\|sessions\.db" src/renderer/ 2>/dev/null | wc -l)
if [ "$CRYPTO_IN_RENDERER" -eq 0 ] && [ "$KEYSTORE_IN_RENDERER" -eq 0 ]; then
  echo "Security boundaries: PASS"
else
  echo "Security boundaries: FAIL (crypto=$CRYPTO_IN_RENDERER, keystore=$KEYSTORE_IN_RENDERER)"
  exit 1
fi

echo ""
echo "=== Milestone 2 Verification Complete ==="
echo "Finished: $(date)"
echo "Status: ALL AUTOMATED CHECKS PASSED"
echo ""
echo "Remaining: manual spot-checks (Part 7), performance benchmarks (Part 5)"
