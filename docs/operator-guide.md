# Mercury Operator Guide

A comprehensive guide for self-hosting Mercury, an end-to-end encrypted communication platform.

Mercury is designed for individuals and organizations who want full control over their communication infrastructure. The server never has access to message content or user private keys -- all encryption happens on the client.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Configuration Reference](#2-configuration-reference)
3. [Port Forwarding Guide](#3-port-forwarding-guide)
4. [Monitoring & Observability](#4-monitoring--observability)
5. [Scaling Triggers](#5-scaling-triggers)
6. [Backup & Restore](#6-backup--restore)
7. [Security Checklist](#7-security-checklist)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Quick Start

### Prerequisites

- **Docker** 24+ and **Docker Compose** v2
- A **domain name** with DNS pointing to your server's public IP
- **TLS certificates** for your domain (Let's Encrypt or your own CA)
- Open ports on your firewall (see [Port Forwarding Guide](#3-port-forwarding-guide))
- At least **4 GB RAM** and **2 CPU cores** (recommended minimum)

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/your-org/mercury.git
cd mercury

# 2. Copy the production environment template
cp .env.prod.example .env.prod

# 3. Generate secrets and edit configuration
#    Generate two separate 64-character random secrets:
openssl rand -base64 48   # Use for MERCURY_AUTH_JWT_SECRET
openssl rand -base64 48   # Use for TURN_SECRET

# 4. Edit .env.prod with your values
#    At minimum, set:
#      - MERCURY_AUTH_JWT_SECRET
#      - TURN_SECRET
#      - PUBLIC_DOMAIN (your domain name)
#      - POSTGRES_PASSWORD (and update MERCURY_DATABASE_URL to match)

# 5. Set up TLS certificates (see TLS section below)
#    Place cert.pem and key.pem in the certs/ directory

# 6. Start all services
docker compose -f docker-compose.prod.yml up -d

# 7. Verify the deployment
curl -sk https://your-domain:8443/health | python3 -m json.tool
```

A healthy response looks like:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "database": "ok",
  "redis": "ok",
  "turn": "ok",
  "uptime_seconds": 42
}
```

If `status` is `"degraded"`, TURN is unreachable but messaging still works. If `status` is `"unhealthy"`, the database or Redis connection has failed and the server cannot operate.

---

## 2. Configuration Reference

Mercury uses a layered configuration system. Values are resolved in this order (highest priority first):

1. **Environment variables** (prefixed with `MERCURY_`)
2. **Config file** (`config/default.toml`)
3. **Built-in defaults**

### Environment Variables

#### Core Server

| Variable | Description | Default |
|----------|-------------|---------|
| `MERCURY_SERVER_HOST` | Bind address | `0.0.0.0` |
| `MERCURY_SERVER_PORT` | HTTPS listen port | `8443` |
| `PUBLIC_DOMAIN` | Public hostname for TURN realm, ICE candidates, and invite links | `localhost` |
| `RUST_LOG` | Log filter directive (development) | `mercury=info` |
| `MERCURY_LOG_LEVEL` | Log filter directive (production, overrides `RUST_LOG`) | -- |
| `CORS_ORIGINS` | Comma-separated allowed CORS origins | (empty = deny all) |

#### Database

| Variable | Description | Default |
|----------|-------------|---------|
| `MERCURY_DATABASE_URL` | PostgreSQL connection string | `postgres://mercury:mercury@localhost:5432/mercury` |
| `POSTGRES_USER` | DB user (Docker init only) | `mercury` |
| `POSTGRES_PASSWORD` | DB password (Docker init only) | `mercury` |
| `POSTGRES_DB` | DB name (Docker init only) | `mercury` |

#### Redis

| Variable | Description | Default |
|----------|-------------|---------|
| `MERCURY_REDIS_URL` | Redis connection string | `redis://localhost:6379` |

#### Authentication

| Variable | Description | Default |
|----------|-------------|---------|
| `MERCURY_AUTH_JWT_SECRET` | JWT signing secret (64+ chars, **required**) | `dev-secret-change-in-production` |

#### TLS

| Variable | Description | Default |
|----------|-------------|---------|
| `MERCURY_TLS_CERT_PATH` | Path to TLS certificate PEM | `./certs/cert.pem` |
| `MERCURY_TLS_KEY_PATH` | Path to TLS private key PEM | `./certs/key.pem` |

#### TURN/STUN

| Variable | Description | Default |
|----------|-------------|---------|
| `TURN_SECRET` | Shared secret for TURN credential generation (64+ chars, **required**) | (empty) |

### Config File (`config/default.toml`)

The config file provides fine-grained control over settings not exposed as environment variables. Key sections:

```toml
[database]
max_connections = 50          # Max DB pool size
min_connections = 5           # Min DB pool size
acquire_timeout_seconds = 5   # Timeout waiting for a connection
idle_timeout_seconds = 600    # Close idle connections after 10 min
max_lifetime_seconds = 1800   # Recycle connections after 30 min

[auth]
jwt_expiry_minutes = 60       # Access token lifetime
refresh_token_expiry_days = 30 # Refresh token lifetime
argon2_memory_kib = 65536     # Argon2id memory parameter
argon2_iterations = 3         # Argon2id iterations
argon2_parallelism = 4        # Argon2id parallelism

[server]
heartbeat_interval_secs = 30  # WebSocket heartbeat interval
auth_rate_limit_per_min = 5   # Auth endpoint rate limit per IP
ws_rate_limit_per_sec = 200   # WebSocket upgrade rate limit (global)

[media]
dedicated_cores = 2               # CPU cores for media runtime
max_participants_per_room = 25    # Max users per voice/video call
empty_room_timeout_secs = 300     # Close empty rooms after 5 min
udp_port_range_start = 10000      # Media UDP port range start
udp_port_range_end = 10100        # Media UDP port range end

[media.audio]
max_bitrate_kbps = 128
preferred_bitrate_kbps = 64

[media.video]
max_bitrate_kbps = 2500
max_resolution = "1280x720"
max_framerate = 30

[media.bandwidth]
total_mbps = 100              # Total bandwidth budget
per_user_kbps = 4000          # Per-user bandwidth limit

[moderation.auto_actions]
enabled = true
rapid_messaging_threshold = 30
rapid_messaging_cooldown_seconds = 600
```

### TLS Certificate Setup

Mercury requires TLS -- it will not serve plaintext HTTP. You have two options:

#### Option A: Let's Encrypt (recommended)

```bash
# Install certbot
sudo apt install certbot  # Debian/Ubuntu
sudo dnf install certbot  # Fedora/RHEL

# Obtain certificates (standalone mode, requires port 80 temporarily open)
sudo certbot certonly --standalone -d your-domain.com

# Copy to Mercury's certs directory
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem certs/cert.pem
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem certs/key.pem
sudo chmod 644 certs/cert.pem
sudo chmod 600 certs/key.pem
```

Set up automatic renewal with a cron job:

```bash
# Add to crontab (crontab -e)
0 3 * * * certbot renew --quiet && \
  cp /etc/letsencrypt/live/your-domain.com/fullchain.pem /path/to/mercury/certs/cert.pem && \
  cp /etc/letsencrypt/live/your-domain.com/privkey.pem /path/to/mercury/certs/key.pem && \
  docker compose -f /path/to/mercury/docker-compose.prod.yml restart mercury coturn
```

#### Option B: Bring Your Own Certificate

Place your certificate chain and private key in the `certs/` directory:

```
certs/
  cert.pem   # Full certificate chain (your cert + intermediates)
  key.pem    # Private key (PEM format, unencrypted)
```

Both the Mercury server and coturn (TURN server) share the same certificate volume.

---

## 3. Port Forwarding Guide

Mercury requires several ports to be forwarded from your router/firewall to the host running Docker.

### Required Ports

| Port | Protocol | Service | Purpose |
|------|----------|---------|---------|
| 443 (or 8443) | TCP | Mercury Server | HTTPS API + WebSocket Secure |
| 3478 | TCP + UDP | coturn | STUN/TURN signaling |
| 5349 | TCP | coturn | TURNS (TLS-secured TURN) |
| 10000-10100 | UDP | Mercury SFU | WebRTC media relay (direct) |
| 49152-49252 | UDP | coturn | TURN relay traffic |

> **Note:** The Docker Compose file maps the server to port 8443. If you want clients to connect on standard port 443, either change the mapping in `docker-compose.prod.yml` or use a reverse proxy.

### Platform-Specific Instructions

#### UFW / iptables (Linux)

```bash
# UFW
sudo ufw allow 8443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 10000:10100/udp
sudo ufw allow 49152:49252/udp

# iptables (equivalent)
sudo iptables -A INPUT -p tcp --dport 8443 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3478 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 3478 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 5349 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 10000:10100 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 49152:49252 -j ACCEPT
```

#### AWS Security Groups

Create or update your security group with these inbound rules:

| Type | Protocol | Port Range | Source |
|------|----------|------------|--------|
| Custom TCP | TCP | 8443 | 0.0.0.0/0 |
| Custom TCP | TCP | 3478 | 0.0.0.0/0 |
| Custom UDP | UDP | 3478 | 0.0.0.0/0 |
| Custom TCP | TCP | 5349 | 0.0.0.0/0 |
| Custom UDP | UDP | 10000-10100 | 0.0.0.0/0 |
| Custom UDP | UDP | 49152-49252 | 0.0.0.0/0 |

Remember: AWS Security Groups are stateful (return traffic is automatically allowed), but you may also need to configure the OS-level firewall inside the instance (see UFW/iptables above).

#### UniFi

1. Go to **Settings > Firewall & Security > Port Forwarding**
2. Create rules for each port/range above
3. **Important:** UniFi requires separate rules for TCP and UDP -- a single "TCP/UDP" rule sometimes only opens TCP. Create explicit UDP rules for ports 3478, 10000-10100, and 49152-49252.
4. Verify with an external port scanner after setup.

#### pfSense

1. Go to **Firewall > NAT > Port Forward**
2. Add rules for each port/range, selecting the correct protocol (TCP, UDP, or TCP/UDP)
3. pfSense auto-creates matching firewall rules -- verify under **Firewall > Rules**

### Common Pitfalls

- **Double NAT:** If your ISP provides a router and you have your own router behind it, you need to forward ports on both devices, or put the ISP router in bridge mode.
- **CGNAT (Carrier-Grade NAT):** Some ISPs place you behind CGNAT, making port forwarding impossible. Contact your ISP to request a public IP, or use a VPS instead.
- **UDP rules on UniFi:** UniFi's "TCP/UDP" option does not always open UDP. Always create separate, explicit UDP rules and verify them.
- **Cloud VM: two firewalls:** AWS, GCP, and Azure all have both a cloud-level firewall (Security Groups / VPC firewall rules) and an OS-level firewall. You must open ports on **both**.
- **Docker and UFW:** Docker modifies iptables directly and can bypass UFW rules. If you need strict firewall control, consider using `DOCKER_IPTABLES=false` or binding services to `127.0.0.1` and using a reverse proxy.

---

## 4. Monitoring & Observability

### Prometheus Metrics

Mercury exposes metrics in Prometheus exposition format at `GET /metrics`.

#### Scrape Configuration

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'mercury'
    scheme: https
    tls_config:
      insecure_skip_verify: true  # Remove if using a trusted CA cert
    static_configs:
      - targets: ['your-domain:8443']
    scrape_interval: 15s
```

#### Key Metrics and Alert Thresholds

| Metric | Type | Alert Condition | Action |
|--------|------|-----------------|--------|
| `mercury_db_pool_acquire_timeouts_total` | Counter | Increasing (rate > 0 over 5m) | Scale DB pool (`max_connections`) or investigate slow queries |
| `mercury_api_request_duration_seconds` | Histogram | p99 > 100ms sustained 5m | Investigate API bottlenecks, consider splitting API/media |
| `mercury_connected_clients` | Gauge | Approaching server capacity | Plan capacity, consider horizontal scaling |
| `mercury_active_calls` | Gauge | Approaching `max_participants_per_room * rooms` | Monitor SFU resource usage |
| `mercury_sfu_rooms_active` | Gauge | Sustained high count | Monitor media bandwidth |
| `mercury_media_bandwidth_bytes` | Gauge | Approaching `total_mbps` budget | Increase bandwidth or reduce video quality limits |
| `mercury_db_pool_connections` | Gauge | `active` near `max_connections` | Increase pool size, investigate connection leaks |
| `mercury_messages_relayed_total` | Counter | Baseline monitoring | Track usage growth |

#### Example Alertmanager Rules

```yaml
groups:
  - name: mercury
    rules:
      - alert: DBPoolTimeouts
        expr: rate(mercury_db_pool_acquire_timeouts_total[5m]) > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Database pool is timing out on connection acquisition"

      - alert: HighAPILatency
        expr: histogram_quantile(0.99, rate(mercury_api_request_duration_seconds_bucket[5m])) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "API p99 latency exceeds 100ms"

      - alert: HighClientCount
        expr: mercury_connected_clients > 500
        for: 1m
        labels:
          severity: info
        annotations:
          summary: "Connected client count is high -- monitor resource usage"
```

### Health Check Endpoint

The `GET /health` endpoint returns structured JSON indicating component status:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "database": "ok",
  "redis": "ok",
  "turn": "ok",
  "uptime_seconds": 86400
}
```

- **`status`**: `ok` (all services healthy), `degraded` (TURN unreachable, messaging works), or `unhealthy` (DB or Redis down)
- **`database`**: Tested with a `SELECT 1` query (2-second timeout)
- **`redis`**: Tested with a `PING` (1-second timeout)
- **`turn`**: Tested with a UDP STUN binding probe

Use this endpoint with uptime monitors (UptimeRobot, Uptime Kuma, etc.) or load balancer health checks.

### Structured Logging

Mercury outputs structured logs to stdout. Configure the log level with:

- **Development:** `RUST_LOG=mercury=debug,tower_http=debug`
- **Production:** `MERCURY_LOG_LEVEL=mercury=info,mercury_media=warn`

Docker captures these logs with the `json-file` driver (max 10MB, 3 rotated files per container). View logs with:

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Specific service
docker compose -f docker-compose.prod.yml logs -f mercury

# Last 100 lines
docker compose -f docker-compose.prod.yml logs --tail 100 mercury
```

---

## 5. Scaling Triggers

Mercury runs all components (API server + SFU media server) in a single process by default. This works well for small to medium deployments. Monitor for these conditions:

### When to Scale

| Condition | Threshold | Sustained For | Action |
|-----------|-----------|---------------|--------|
| API p99 latency | > 100ms | 5 minutes | Split API and Media into separate containers |
| SFU audio jitter | > 20ms | 5 minutes | Split API and Media into separate containers |
| DB pool active connections | Near `max_connections` | -- | Increase `max_connections` in config |
| DB pool acquire timeouts | Any | 5 minutes | Increase `max_connections` or investigate slow queries |
| Connected clients | Approaching capacity | -- | Add resources or plan a second instance |

### How to Split API and Media

When a single process can no longer handle both API and media workloads:

1. Create two separate services in your `docker-compose.prod.yml`, both using the same Mercury image but with different configurations:

```yaml
services:
  mercury-api:
    # ... same image, volumes, env
    environment:
      - MERCURY_MEDIA_ENABLED=false
    ports:
      - "8443:8443"

  mercury-media:
    # ... same image, volumes, env
    environment:
      - MERCURY_API_ENABLED=false
    ports:
      - "10000-10100:10000-10100/udp"
```

2. Both services share the same PostgreSQL and Redis instances.
3. Route WebSocket connections for signaling to the API service and WebRTC media to the media service.

### Database Pool Tuning

Adjust these settings in `config/default.toml` based on your workload:

- **`max_connections`**: Start at 50. Increase if you see pool acquire timeouts. A good rule of thumb is 2-3 connections per expected concurrent user, up to your PostgreSQL `max_connections` limit (default 100, increase in `postgresql.conf`).
- **`acquire_timeout_seconds`**: Keep at 5 seconds. If requests are timing out here, the pool is saturated.
- **`idle_timeout_seconds`**: 600 seconds (10 min) is reasonable. Lower if you need to free connections faster.

---

## 6. Backup & Restore

### PostgreSQL

Mercury's PostgreSQL database stores user accounts, server/channel metadata, encrypted message ciphertexts, key bundles, and moderation data.

#### Backup

```bash
# One-time backup
docker compose -f docker-compose.prod.yml exec db \
  pg_dump -U mercury -Fc mercury > backup_$(date +%Y%m%d_%H%M%S).dump

# Automated daily backup (add to crontab -e)
0 2 * * * docker compose -f /path/to/mercury/docker-compose.prod.yml exec -T db \
  pg_dump -U mercury -Fc mercury > /path/to/backups/mercury_$(date +\%Y\%m\%d).dump 2>&1
```

#### Restore

```bash
# Stop the Mercury server first
docker compose -f docker-compose.prod.yml stop mercury

# Restore from backup
docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U mercury -d mercury --clean --if-exists < backup_20260307.dump

# Restart
docker compose -f docker-compose.prod.yml start mercury
```

### Redis

Redis is configured with AOF (Append-Only File) persistence (`--appendonly yes`). Data is stored in the `redisdata` Docker volume.

```bash
# Backup the Redis data volume
docker compose -f docker-compose.prod.yml stop redis
docker run --rm -v mercury_redisdata:/data -v $(pwd)/backups:/backup \
  alpine tar czf /backup/redis_$(date +%Y%m%d).tar.gz -C /data .
docker compose -f docker-compose.prod.yml start redis
```

Redis stores ephemeral data (sessions, presence, rate limit counters). Losing Redis data is not catastrophic -- users will need to re-authenticate, but no permanent data is lost.

### TLS Certificates

Back up the `certs/` directory (or the `certs` Docker volume if managed externally):

```bash
tar czf certs_backup_$(date +%Y%m%d).tar.gz certs/
```

### What Is NOT Backed Up

Mercury is end-to-end encrypted. The server **never** has access to:

- **Decrypted message content** -- the server only stores per-device ciphertexts that it cannot read
- **User private keys** -- generated and stored exclusively on the client device
- **Decryption keys** -- managed by the Double Ratchet protocol on each client

Users are responsible for their own key backups via Mercury's encrypted key backup feature. If a user loses all their devices and has no key backup, their message history is unrecoverable by design.

---

## 7. Security Checklist

Complete all items before exposing Mercury to the internet.

- [ ] **Change all default secrets in `.env.prod`**
  - `MERCURY_AUTH_JWT_SECRET` -- unique, 64+ character random string
  - `TURN_SECRET` -- unique, 64+ character random string (different from JWT secret)
  - `POSTGRES_PASSWORD` -- strong password, updated in both `POSTGRES_PASSWORD` and `MERCURY_DATABASE_URL`

- [ ] **Enable TLS**
  - Valid certificates in `certs/cert.pem` and `certs/key.pem`
  - Mercury enforces TLS-only -- never run without certificates

- [ ] **Set `PUBLIC_DOMAIN` correctly**
  - Must match your actual domain name
  - Used for TURN realm, ICE candidate generation, and invite links

- [ ] **Review firewall rules**
  - Only required ports are open (see [Port Forwarding Guide](#3-port-forwarding-guide))
  - PostgreSQL (5432) and Redis (6379) are NOT exposed externally
  - Verify with an external port scanner

- [ ] **Verify TURN connectivity**
  - TURN is required for voice/video calls behind NATs
  - Test with the health endpoint: `turn` field should be `"ok"`

- [ ] **Verify health endpoint**
  - `curl -sk https://your-domain:8443/health` returns `"status": "ok"`
  - All components (database, redis, turn) show as connected

- [ ] **Review Docker resource limits**
  - Default limits: Mercury (4 CPU, 2GB RAM), PostgreSQL (2 CPU, 1GB RAM), Redis (1 CPU, 512MB RAM)
  - Adjust in `docker-compose.prod.yml` based on your hardware

- [ ] **Set appropriate log level**
  - Use `MERCURY_LOG_LEVEL=mercury=info` in production (not `debug`)
  - Debug logging can expose sensitive request details

- [ ] **Keep Docker images updated**
  - Regularly pull updated base images and rebuild
  - Subscribe to security advisories for PostgreSQL, Redis, and coturn

---

## 8. Troubleshooting

### Voice/video not working

Voice and video calls require TURN to be properly configured and accessible.

1. **Check health endpoint:** `curl -sk https://your-domain:8443/health | grep turn`
   - If `"turn": "unreachable"`, coturn is not running or not accessible
2. **Check coturn logs:** `docker compose -f docker-compose.prod.yml logs coturn`
3. **Verify UDP ports are open:** Use an external tool to test ports 3478/udp, 49152-49252/udp
4. **Check `TURN_SECRET`:** Must match between `.env.prod` (used by coturn) and the Mercury server
5. **Check `PUBLIC_DOMAIN`:** Must resolve to your server's public IP. TURN realm uses this value.
6. **Common fix (UniFi):** Create separate explicit UDP forwarding rules -- the combined TCP/UDP option often fails for UDP.

### Users can't connect

1. **Check TLS certificate:** `openssl s_client -connect your-domain:8443 -servername your-domain`
   - Verify the certificate chain is valid and not expired
2. **Check DNS resolution:** `dig your-domain` or `nslookup your-domain` -- must point to your server
3. **Check firewall:** Verify port 8443/tcp is open from the client's network
4. **Check server logs:** `docker compose -f docker-compose.prod.yml logs mercury`
5. **Check container health:** `docker compose -f docker-compose.prod.yml ps` -- all services should be `healthy` or `running`

### Slow performance

1. **Check API latency:** Query Prometheus for `histogram_quantile(0.99, rate(mercury_api_request_duration_seconds_bucket[5m]))`
2. **Check DB pool:** `curl -sk https://your-domain:8443/metrics | grep mercury_db_pool`
   - If `active` is near `max_connections`, increase the pool size
   - If `acquire_timeouts_total` is increasing, the pool is saturated
3. **Check container resources:** `docker stats` -- look for CPU/memory throttling
4. **Check PostgreSQL:** Connect and run `SELECT * FROM pg_stat_activity WHERE state = 'active'` to find slow queries
5. **Consider splitting:** If API and media are competing for resources, split into separate containers (see [Scaling Triggers](#5-scaling-triggers))

### Out of memory

1. **Check Docker resource limits:** `docker compose -f docker-compose.prod.yml ps` and `docker stats`
   - Default: Mercury 2GB, PostgreSQL 1GB, Redis 512MB
   - Increase limits in `docker-compose.prod.yml` under `deploy.resources.limits`
2. **Check Redis memory:** `docker compose -f docker-compose.prod.yml exec redis redis-cli info memory`
   - If Redis is using too much memory, consider setting `maxmemory` and `maxmemory-policy` in the Redis command
3. **Check PostgreSQL:** Large numbers of connections consume memory. Each connection uses ~5-10MB. Reduce `max_connections` if you have too many idle connections.
4. **Media server:** Video calls with many participants are memory-intensive. Reduce `max_participants_per_room` or `media.video.max_bitrate_kbps` if needed.

### Database connection errors

1. **Check PostgreSQL is running:** `docker compose -f docker-compose.prod.yml ps db`
2. **Check connection string:** Ensure `MERCURY_DATABASE_URL` credentials match `POSTGRES_USER` and `POSTGRES_PASSWORD`
3. **Check pool saturation:** If the pool is full, requests queue until `acquire_timeout_seconds` (default 5s) and then fail
4. **Check max connections:** PostgreSQL default is 100 connections. If Mercury's `max_connections` (50) plus any direct connections exceed this, increase PostgreSQL's `max_connections` in `postgresql.conf` or via Docker environment variable `POSTGRES_MAX_CONNECTIONS`

### Container keeps restarting

1. **Check logs:** `docker compose -f docker-compose.prod.yml logs mercury --tail 50`
2. **Common causes:**
   - Missing or invalid TLS certificates
   - Invalid `MERCURY_DATABASE_URL` (can't connect to PostgreSQL)
   - Missing required environment variables (`MERCURY_AUTH_JWT_SECRET`)
   - Port already in use on the host
3. **Check dependencies:** Mercury waits for PostgreSQL to be healthy before starting. If PostgreSQL never becomes healthy, Mercury won't start.
