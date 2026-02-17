# Milestone 1 Integration Tests

End-to-end tests covering Phases 1–4 (health, schema, auth, WebSocket).

## Prerequisites

- **Docker Compose** infrastructure running (`docker compose up -d`)
- A `mercury_test` database created in the Dockerized Postgres

Create the test database (one-time setup):

```bash
docker compose exec postgres psql -U mercury -c "CREATE DATABASE mercury_test;"
```

## Running

From the workspace root (`src/server/`):

```bash
export DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury_test"
cargo test --test milestone_1 -- --test-threads=1
```

Or with nextest:

```bash
export DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury_test"
cargo nextest run --test milestone_1 -j 1
```

Tests **must** run sequentially because they share database and Redis state.
Each test calls `setup()` to truncate all tables and flush Redis before running.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://mercury:mercury@localhost:5432/mercury_test` | Test database connection string |
| `MERCURY_REDIS_URL` | `redis://localhost:6379` | Redis connection string |

## Timing Notes

The test server uses a 5-second heartbeat interval (vs 30s in production) to
keep the suite fast.

- `test_ws_missed_heartbeats_disconnect` takes ~20s (5s interval x 3 misses + buffer)
- `test_ws_presence_goes_offline_after_debounce` takes ~18s (15s debounce + buffer)
- `test_ws_cross_user_presence` takes ~20s (includes debounce wait)
