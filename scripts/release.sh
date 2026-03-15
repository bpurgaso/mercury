#!/usr/bin/env bash
#
# release.sh — Build Mercury production release artifacts.
#
# Bumps version numbers, builds the server Docker image and standalone binary,
# and builds client installers for Linux and Windows. Optionally creates a
# GitHub release with all artifacts attached.
#
# Platform: Linux (x86_64). Cross-compiles Windows client via electron-builder.
#
# Prerequisites:
#   - Docker and Docker Compose
#   - Rust toolchain (stable)
#   - Node.js 20+ with pnpm
#   - For Windows client: wine (optional, cross-build may be flaky)
#   - For GitHub release: gh CLI authenticated
#
# Usage:
#   ./scripts/release.sh <version>                # Build all artifacts
#   ./scripts/release.sh <version> --server-only  # Server artifacts only
#   ./scripts/release.sh <version> --client-only  # Client artifacts only
#   ./scripts/release.sh <version> --skip-windows # Skip Windows client build
#   ./scripts/release.sh <version> --github       # Also create GitHub release
#   ./scripts/release.sh <version> --dry-run      # Show what would be done
#
# Examples:
#   ./scripts/release.sh 1.0.0
#   ./scripts/release.sh 1.0.0 --github
#   ./scripts/release.sh 1.2.3 --skip-windows --github
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/src/server"
CLIENT_DIR="$REPO_ROOT/src/client"

# ── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Parse arguments ─────────────────────────────────────────────────────────

VERSION=""
SERVER_ONLY=false
CLIENT_ONLY=false
SKIP_WINDOWS=false
GITHUB_RELEASE=false
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --server-only)  SERVER_ONLY=true ;;
        --client-only)  CLIENT_ONLY=true ;;
        --skip-windows) SKIP_WINDOWS=true ;;
        --github)       GITHUB_RELEASE=true ;;
        --dry-run)      DRY_RUN=true ;;
        --help|-h)
            echo "Usage: $0 <version> [--server-only] [--client-only] [--skip-windows] [--github] [--dry-run]"
            echo ""
            echo "  <version>       Semantic version (e.g. 1.0.0)"
            echo "  --server-only   Build only server artifacts"
            echo "  --client-only   Build only client artifacts"
            echo "  --skip-windows  Skip Windows client cross-build"
            echo "  --github        Create a GitHub release with artifacts"
            echo "  --dry-run       Show what would be done without executing"
            exit 0
            ;;
        -*)
            echo -e "${RED}ERROR: Unknown option: $arg${NC}"
            echo "Run $0 --help for usage."
            exit 1
            ;;
        *)
            if [[ -z "$VERSION" ]]; then
                VERSION="$arg"
            else
                echo -e "${RED}ERROR: Unexpected argument: $arg${NC}"
                exit 1
            fi
            ;;
    esac
done

if [[ -z "$VERSION" ]]; then
    echo -e "${RED}ERROR: Version argument is required.${NC}"
    echo "Usage: $0 <version> [options]"
    echo "Example: $0 1.0.0"
    exit 1
fi

# ── Validate version format ────────────────────────────────────────────────

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${RED}ERROR: Version must be in semver format (e.g. 1.0.0), got: $VERSION${NC}"
    exit 1
fi

if [[ "$SERVER_ONLY" == true && "$CLIENT_ONLY" == true ]]; then
    echo -e "${RED}ERROR: --server-only and --client-only are mutually exclusive.${NC}"
    exit 1
fi

BUILD_SERVER=true
BUILD_CLIENT=true
if [[ "$SERVER_ONLY" == true ]]; then BUILD_CLIENT=false; fi
if [[ "$CLIENT_ONLY" == true ]]; then BUILD_SERVER=false; fi

# ── Preflight checks ──────────────────────────────────────────────────────

echo -e "${CYAN}==> Checking prerequisites...${NC}"

missing=()

if [[ "$BUILD_SERVER" == true ]]; then
    command -v docker &>/dev/null || missing+=("docker")
    command -v cargo  &>/dev/null || missing+=("cargo (rustup)")
fi

if [[ "$BUILD_CLIENT" == true ]]; then
    command -v node &>/dev/null || missing+=("node")
    command -v pnpm &>/dev/null || missing+=("pnpm")
fi

if [[ "$GITHUB_RELEASE" == true ]]; then
    command -v gh &>/dev/null || missing+=("gh (GitHub CLI)")
fi

if [[ ${#missing[@]} -gt 0 ]]; then
    echo -e "${RED}ERROR: Missing required tools: ${missing[*]}${NC}"
    exit 1
fi

# Check for clean git working tree
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
    echo -e "${YELLOW}WARNING: Git working tree is not clean.${NC}"
    echo "  Uncommitted changes may be included in the build."
    echo ""
    read -rp "Continue anyway? [y/N] " confirm
    if [[ "$confirm" != [yY] ]]; then
        echo "Aborted."
        exit 1
    fi
fi

# Check that the git tag doesn't already exist
if git -C "$REPO_ROOT" rev-parse "v$VERSION" &>/dev/null; then
    echo -e "${RED}ERROR: Git tag v$VERSION already exists.${NC}"
    echo "  Use a different version or delete the existing tag first."
    exit 1
fi

# Check for wine if building Windows client
if [[ "$BUILD_CLIENT" == true && "$SKIP_WINDOWS" == false ]]; then
    if ! command -v wine &>/dev/null; then
        echo -e "${YELLOW}WARNING: wine is not installed. Windows cross-build may fail.${NC}"
        echo "  Use --skip-windows to skip, or install wine for cross-compilation."
        echo ""
        read -rp "Continue without wine? [y/N] " confirm
        if [[ "$confirm" != [yY] ]]; then
            echo "Aborted."
            exit 1
        fi
    fi
fi

# ── Dry run summary ────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo -e "${BOLD}  Mercury Release v$VERSION${NC}"
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo ""
echo "  Build server:         $BUILD_SERVER"
echo "  Build Linux client:   $BUILD_CLIENT"
echo "  Build Windows client: $([[ "$BUILD_CLIENT" == true && "$SKIP_WINDOWS" == false ]] && echo true || echo false)"
echo "  GitHub release:       $GITHUB_RELEASE"
echo ""

if [[ "$DRY_RUN" == true ]]; then
    echo -e "${YELLOW}Dry run — no changes will be made.${NC}"
    exit 0
fi

read -rp "Proceed with release? [y/N] " confirm
if [[ "$confirm" != [yY] ]]; then
    echo "Aborted."
    exit 1
fi

# ── Step 1: Bump versions ──────────────────────────────────────────────────

echo ""
echo -e "${CYAN}==> [1] Bumping version to $VERSION...${NC}"

if [[ "$BUILD_SERVER" == true ]]; then
    sed -i "s/^version = \".*\"/version = \"$VERSION\"/" "$SERVER_DIR/Cargo.toml"
    echo -e "${GREEN}    Updated src/server/Cargo.toml${NC}"

    # Regenerate Cargo.lock with new version
    (cd "$SERVER_DIR" && cargo generate-lockfile --quiet)
    echo -e "${GREEN}    Regenerated Cargo.lock${NC}"
fi

if [[ "$BUILD_CLIENT" == true ]]; then
    # Use node to update package.json version to avoid sed issues with JSON
    node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('$CLIENT_DIR/package.json', 'utf8'));
        pkg.version = '$VERSION';
        fs.writeFileSync('$CLIENT_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
    echo -e "${GREEN}    Updated src/client/package.json${NC}"
fi

# ── Step 2: Build server ───────────────────────────────────────────────────

ARTIFACTS=()

if [[ "$BUILD_SERVER" == true ]]; then
    echo ""
    echo -e "${CYAN}==> [2] Building server...${NC}"

    # Build standalone binary
    echo -e "${CYAN}    Building release binary...${NC}"
    (cd "$SERVER_DIR" && cargo build --release --bin mercury-server)
    BINARY="$SERVER_DIR/target/release/mercury-server"

    if [[ ! -f "$BINARY" ]]; then
        echo -e "${RED}ERROR: Server binary not found at $BINARY${NC}"
        exit 1
    fi

    BINARY_SIZE=$(du -h "$BINARY" | cut -f1)
    echo -e "${GREEN}    Binary built: $BINARY ($BINARY_SIZE)${NC}"

    # Build Docker image
    echo -e "${CYAN}    Building Docker image...${NC}"
    docker build -t "mercury-server:$VERSION" -t mercury-server:latest "$REPO_ROOT"
    echo -e "${GREEN}    Docker image tagged: mercury-server:$VERSION${NC}"

    # Export Docker image as tarball
    DOCKER_TAR="$REPO_ROOT/dist/mercury-server-$VERSION-docker.tar.gz"
    mkdir -p "$REPO_ROOT/dist"
    docker save "mercury-server:$VERSION" | gzip > "$DOCKER_TAR"
    TAR_SIZE=$(du -h "$DOCKER_TAR" | cut -f1)
    echo -e "${GREEN}    Docker image exported: $DOCKER_TAR ($TAR_SIZE)${NC}"

    ARTIFACTS+=("$BINARY" "$DOCKER_TAR")
else
    echo ""
    echo -e "${YELLOW}==> [2] Skipping server build (--client-only)${NC}"
fi

# ── Step 3: Build Linux client ─────────────────────────────────────────────

if [[ "$BUILD_CLIENT" == true ]]; then
    echo ""
    echo -e "${CYAN}==> [3] Building Linux client...${NC}"

    (cd "$CLIENT_DIR" && pnpm install --frozen-lockfile)
    (cd "$CLIENT_DIR" && pnpm run build:linux)

    echo -e "${GREEN}    Linux client artifacts:${NC}"
    for f in "$CLIENT_DIR"/dist/*.{AppImage,deb,rpm,flatpak} 2>/dev/null; do
        if [[ -f "$f" ]]; then
            SIZE=$(du -h "$f" | cut -f1)
            echo -e "${GREEN}      $(basename "$f") ($SIZE)${NC}"
            ARTIFACTS+=("$f")
        fi
    done
else
    echo ""
    echo -e "${YELLOW}==> [3] Skipping client build (--server-only)${NC}"
fi

# ── Step 4: Build Windows client ───────────────────────────────────────────

if [[ "$BUILD_CLIENT" == true && "$SKIP_WINDOWS" == false ]]; then
    echo ""
    echo -e "${CYAN}==> [4] Building Windows client (cross-compile)...${NC}"

    if (cd "$CLIENT_DIR" && pnpm run build:win); then
        echo -e "${GREEN}    Windows client artifacts:${NC}"
        for f in "$CLIENT_DIR"/dist/*.exe 2>/dev/null; do
            if [[ -f "$f" ]]; then
                SIZE=$(du -h "$f" | cut -f1)
                echo -e "${GREEN}      $(basename "$f") ($SIZE)${NC}"
                ARTIFACTS+=("$f")
            fi
        done
    else
        echo -e "${YELLOW}    WARNING: Windows cross-build failed. Skipping Windows artifacts.${NC}"
        echo -e "${YELLOW}    Build natively on Windows for reliable .exe output.${NC}"
    fi
else
    echo ""
    echo -e "${YELLOW}==> [4] Skipping Windows client build${NC}"
fi

# ── Step 5: Create git tag ─────────────────────────────────────────────────

echo ""
echo -e "${CYAN}==> [5] Creating git tag v$VERSION...${NC}"

git -C "$REPO_ROOT" add -A
git -C "$REPO_ROOT" commit -m "release: bump version to $VERSION"
git -C "$REPO_ROOT" tag -a "v$VERSION" -m "Mercury v$VERSION"
echo -e "${GREEN}    Tag v$VERSION created.${NC}"

# ── Step 6: GitHub release ─────────────────────────────────────────────────

if [[ "$GITHUB_RELEASE" == true ]]; then
    echo ""
    echo -e "${CYAN}==> [6] Creating GitHub release...${NC}"

    # Push the tag
    git -C "$REPO_ROOT" push origin main
    git -C "$REPO_ROOT" push origin "v$VERSION"

    # Build the gh release create command with available artifacts
    GH_ARGS=()
    for artifact in "${ARTIFACTS[@]}"; do
        if [[ -f "$artifact" ]]; then
            GH_ARGS+=("$artifact")
        fi
    done

    gh release create "v$VERSION" \
        "${GH_ARGS[@]}" \
        --title "Mercury v$VERSION" \
        --notes "$(cat <<EOF
## Mercury v$VERSION

### Server
- Docker image: \`mercury-server:$VERSION\`
- Standalone Linux binary included

### Client
- Linux: AppImage, .deb, .rpm
$([[ "$SKIP_WINDOWS" == false ]] && echo "- Windows: NSIS installer, portable .exe" || echo "- Windows: not included in this release")

See [docs/release-runbook.md](docs/release-runbook.md) for deployment instructions.
EOF
)"

    echo -e "${GREEN}    GitHub release created.${NC}"
else
    echo ""
    echo -e "${YELLOW}==> [6] Skipping GitHub release (use --github to create one)${NC}"
    echo "    To push and release manually:"
    echo "      git push origin main"
    echo "      git push origin v$VERSION"
fi

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo -e "${BOLD}  Release v$VERSION complete${NC}"
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo ""
echo "  Artifacts:"
for artifact in "${ARTIFACTS[@]}"; do
    if [[ -f "$artifact" ]]; then
        SIZE=$(du -h "$artifact" | cut -f1)
        echo "    $(basename "$artifact") ($SIZE)"
    fi
done
echo ""
echo -e "${GREEN}  Done.${NC}"
