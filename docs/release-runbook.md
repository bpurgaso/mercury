# Mercury Production Release Runbook

## Prerequisites

- Docker installed (for server)
- Node.js 20+, pnpm, and platform build tools (for client)
- On Linux: `dpkg`, `rpm`, `flatpak-builder` (for all Linux targets)
- For Windows builds from Linux: `wine` and `mono` (or build on a Windows machine)

---

## Step 1: Bump Versions

**Server** — edit `src/server/Cargo.toml`:
```toml
[workspace.package]
version = "X.Y.Z"
```

**Client** — edit `src/client/package.json`:
```json
"version": "X.Y.Z",
```

---

## Step 2: Build the Server (Docker Image)

```bash
# From project root
docker compose -f docker-compose.prod.yml build mercury

# Tag for release
docker tag mercury-mercury:latest mercury-server:X.Y.Z
```

Or build a standalone binary (no Docker):
```bash
cd src/server
cargo build --release --bin mercury-server
# Binary at: target/release/mercury-server
```

---

## Step 3: Build the Linux Client

```bash
cd src/client
pnpm install
pnpm run build:linux
```

**Output** in `src/client/dist/`:
- `Mercury-X.Y.Z.AppImage` (x64 + arm64)
- `mercury-client_X.Y.Z_amd64.deb`
- `mercury-client-X.Y.Z.x86_64.rpm`
- `mercury-client-X.Y.Z.flatpak`

---

## Step 4: Build the Windows Client

**Option A — From a Windows machine:**
```bash
cd src/client
pnpm install
pnpm run build:win
```

**Option B — Cross-compile from Linux** (requires wine):
```bash
cd src/client
pnpm install
pnpm run build:win
```

**Output** in `src/client/dist/`:
- `Mercury Setup X.Y.Z.exe` (NSIS installer, x64 + arm64)
- `Mercury X.Y.Z.exe` (portable)

---

## Step 5: Deploy the Server

```bash
# Configure production environment
cp .env.prod.example .env.prod
# Edit .env.prod with real values:
#   - MERCURY_AUTH_JWT_SECRET
#   - POSTGRES_PASSWORD
#   - TURN_SECRET
#   - PUBLIC_DOMAIN
#   - TLS certificate paths

# Start the full production stack
./scripts/prod-start.sh
```

---

## Step 6: Create a Git Tag & GitHub Release

```bash
git tag -a vX.Y.Z -m "Mercury vX.Y.Z"
git push origin vX.Y.Z

# Create GitHub release with client artifacts
gh release create vX.Y.Z \
  src/client/dist/Mercury-X.Y.Z.AppImage \
  src/client/dist/mercury-client_X.Y.Z_amd64.deb \
  src/client/dist/mercury-client-X.Y.Z.x86_64.rpm \
  "src/client/dist/Mercury Setup X.Y.Z.exe" \
  "src/client/dist/Mercury X.Y.Z.exe" \
  --title "Mercury vX.Y.Z" \
  --notes "Release notes here"
```

---

## Notes

- Update the `publish.url` in `src/client/electron-builder.config.yml` to your actual update server before building if you want auto-updates to work.
- Windows cross-compilation from Linux can be flaky with native modules (`better-sqlite3-multiple-ciphers`, `sodium-native`). Building natively on Windows is more reliable.
- Exact output filenames may vary slightly based on electron-builder version — check `src/client/dist/` after the build.
- The server health check endpoint is `https://localhost:8443/health`.
- Prometheus metrics are exposed on port 9090.
