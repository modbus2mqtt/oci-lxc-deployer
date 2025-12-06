#!/bin/sh
set -eu

# test-build.sh
# Local testing script for package.sh and docker/build.sh
# This script validates the modular build components locally before CI/CD

echo "=== Local Build Test ==="
echo "Testing modular build components..."

# Get script path and source utilities
script_path="$(readlink -f "$0")"
script_dir="$(dirname "$script_path")"

# shellcheck source=./arch-utils.sh
. "$script_dir/arch-utils.sh"
find_repo_root "$script_path"

echo "Repository root: $REPO_ROOT"
cd "$REPO_ROOT"

# Check required environment variables
if [ -z "${PACKAGER_PRIVKEY:-}" ]; then
    echo "ERROR: PACKAGER_PRIVKEY environment variable must be set" >&2
    echo "This must contain the private APK signing key contents (PEM)" >&2
    exit 1
fi

echo ""
echo "=== Step 1: Testing APK Package Build (generic) ==="
PKG_BASE="alpine/package"
GENERATOR="$PKG_BASE/generate-ap.sh"

# Generate package directories from INI files if generator exists
if [ -x "$GENERATOR" ]; then
    echo "Running generate-ap.sh for all INI files..."
    find "$PKG_BASE" -maxdepth 1 -type f -name "*.ini" | while read -r ini; do
        pkg="$(basename "$ini" .ini)"
        echo "  -> Generating package dir for $pkg"
        (cd "$PKG_BASE" && ./generate-ap.sh "$pkg" "$pkg.ini" && grep -v "shasums=" "$pkg/APKBUILD" >/dev/null 2>&1 && echo "     -> OK: $pkg APKBUILD generated") || {
            echo "ERROR: generate-ap.sh failed for $pkg" >&2
            exit 1
        }   
    done
fi

echo "Building APKs inside Docker (Alpine) because abuild isn't supported on macOS..."
status=0
# Detect Alpine version to align with other build scripts
detect_alpine_version || true
ALPINE_VERSION="${ALPINE_VERSION:-3.19}"
echo "Using Alpine version: $ALPINE_VERSION"

# Prepare npm cache directory on host to speed up repeated builds
NPM_CACHE_DIR="$REPO_ROOT/alpine/cache/npm"
mkdir -p "$NPM_CACHE_DIR"

# Prepare APK cache directory on host to speed up apk installs
APK_CACHE_DIR="$REPO_ROOT/alpine/cache/apk"
mkdir -p "$APK_CACHE_DIR"


# Clean local repo to avoid mixing packages signed with different keys
REPO_DIR="$REPO_ROOT/alpine/repo"
echo "Cleaning local APK repo at $REPO_DIR to avoid signature mismatches..."
rm -rf "$REPO_DIR" 2>/dev/null || true
mkdir -p "$REPO_DIR"

# Optional: build only specific packages via BUILD_ONLY (space-separated)
BUILD_ONLY="${BUILD_ONLY:-}"

# Build only packages that have an .ini file
for ini in "$PKG_BASE"/*.ini; do
    [ -f "$ini" ] || continue
    pkg="$(basename "$ini" .ini)"

    # Filter by BUILD_ONLY if set
    if [ -n "$BUILD_ONLY" ]; then
        echo "$BUILD_ONLY" | grep -qw "$pkg" || continue
    fi

    # Ensure package directory exists after generation
    if [ ! -d "$PKG_BASE/$pkg" ]; then
        echo "Skipping $pkg: generated package directory not found"
        continue
    fi
    if [ ! -f "$PKG_BASE/$pkg/APKBUILD" ]; then
        echo "Skipping $pkg: no APKBUILD found after generation"
        continue
    fi

    echo "--- Building $pkg in container from $REPO_ROOT ---"
    echo ""$(id -u)":"$(id -g)""  # Debug: show UID:GID
    docker run --rm \
        -e PACKAGER_PRIVKEY \
        -e PKG_NAME="$pkg" \
        -e PKG_BASE="$PKG_BASE" \
        -e ALPINE_VERSION="$ALPINE_VERSION" \
        -e ALLOW_UNTRUSTED=1 \
        -e NPM_CONFIG_CACHE="/home/builder/.npm" \
        -e npm_config_cache="/home/builder/.npm" \
        -e HOST_UID="$(id -u)" \
        -e HOST_GID="$(id -g)" \
        -v "$REPO_ROOT":"/work" \
        -v "$NPM_CACHE_DIR":"/home/builder/.npm" \
        -v "$APK_CACHE_DIR":"/var/cache/apk" \
        -w "/work" \
        alpine:"$ALPINE_VERSION" sh -lc 'sh /work/alpine/package-build.sh' || status=1
done

if [ "$status" -ne 0 ]; then
    echo "ERROR: One or more APK builds failed" >&2
    exit 1
else
    echo "=== All APK builds completed successfully ==="
fi
