#!/bin/sh
set -e

# package-build.sh
# Container-internal script for building modbus2mqtt APK
# This script runs inside the Alpine container and expects:
# Environment: PACKAGER_PRIVKEY, PKG_VERSION, HOST_UID, HOST_GID, ALPINE_VERSION

echo "=== APK Build Container Script ==="
echo "Alpine version: $ALPINE_VERSION"
echo "Package version: $PKG_VERSION"
echo "Build user: builder ($HOST_UID:$HOST_GID)"

# Setup Alpine repositories
ALPINE_REPO_VER="v${ALPINE_VERSION}"
cat > /etc/apk/repositories <<-REPO
https://dl-cdn.alpinelinux.org/alpine/${ALPINE_REPO_VER}/main
https://dl-cdn.alpinelinux.org/alpine/${ALPINE_REPO_VER}/community
REPO

if ! apk update >/dev/null 2>&1; then
  echo "ERROR: failed to use alpine repositories for ${ALPINE_REPO_VER}" >&2
  exit 1
fi

# Install build dependencies
echo "Installing build dependencies..."
APK_ADD_FLAGS="--no-progress --update"
apk $APK_ADD_FLAGS add abuild alpine-sdk nodejs npm git shadow openssl doas >/dev/null 2>&1 || {
  echo "WARN: apk add failed, retrying with default options" >&2
  apk add abuild alpine-sdk nodejs npm git shadow openssl doas >/dev/null 2>&1
}
mkdir -p /etc/doas.d
echo 'permit nopass :dialout as root' > /etc/doas.d/doas.conf || true

# Setup groups and users
if ! getent group dialout >/dev/null 2>&1; then
  addgroup -g "${HOST_GID}" dialout >/dev/null 2>&1 || true
fi
echo "Adding build user and groups..."

adduser -D -u "${HOST_UID}" -G dialout builder || true
addgroup builder abuild || true
mkdir -p /home/builder
chown builder:dialout /home/builder || true
mkdir -p /home/builder/.npm
chown -R builder:dialout /home/builder/.npm || true

# Setup abuild keys
echo "Setting up signing keys..."
mkdir -p /home/builder/.abuild
printf '%s' "$PACKAGER_PRIVKEY" > /home/builder/.abuild/builder-6904805d.rsa

# Generate public key from private key
echo "Generating public key from private key..."
if openssl rsa -in /home/builder/.abuild/builder-6904805d.rsa -pubout -out /home/builder/.abuild/builder-6904805d.rsa.pub 2>/dev/null; then
  echo "✓ Public key generated successfully"
else
  echo "ERROR: Failed to generate public key from private key" >&2
  openssl rsa -in /home/builder/.abuild/builder-6904805d.rsa -pubout -out /home/builder/.abuild/builder-6904805d.rsa.pub 2>&1 || true
  exit 1
fi

chmod 600 /home/builder/.abuild/builder-6904805d.rsa || true
chown -R builder:dialout /home/builder/.abuild || true
cp /home/builder/.abuild/builder-6904805d.rsa.pub /etc/apk/keys || true

# Create abuild configuration
cat > /home/builder/.abuild/abuild.conf <<-EOF
PACKAGER_PRIVKEY="/home/builder/.abuild/builder-6904805d.rsa"
PACKAGER_PUBKEY="/home/builder/.abuild/builder-6904805d.rsa.pub"
REPODEST="/work/alpine"
EOF
chmod 600 /home/builder/.abuild/abuild.conf || true
chown builder:dialout /home/builder/.abuild/abuild.conf || true

# Prepare source
echo "Preparing source code..." >&2
rm -rf /work/src/node_modules || true
# has been set in generate-ap.sh sed -i 's/pkgver=.*/pkgver='"${PKG_VERSION}"'/g' /work/APKBUILD || true

# Build APK as builder user
echo "Building APK version $PKG_VERSION into /work/alpine/repo/<arch>"
su - builder -s /bin/sh -c '
  set -e
  cd /work/'"$PKG_BASE"'/'"$PKG_NAME"'
 
  # Configure abuild to build directly to the mounted repo directory
  export REPODEST="/work/alpine"
  export repo="repo"
  
  # Clean old APK files first (abuild will create the architecture subdirectory)
  rm -f "$REPODEST"/repo/*/'"$PKG_NAME"'*.apk || true
  echo "Building checksum... " >&2
  # prepare abuild and build package (checksum + build/sign)
  # Use timeout and retry to avoid occasional hangs
  abuild checksum || true

  tries=0
  max_tries=2
  while [ $tries -le $max_tries ]; do
    if timeout 20m abuild -r; then
      build_ok=1
      break
    fi
    tries=$((tries+1))
    echo "WARN: abuild run failed or timed out (attempt $tries/$max_tries), retrying..." >&2
    sleep 3
  done
  [ "${build_ok:-0}" -eq 1 ] || { echo "ERROR: abuild failed after retries" >&2; exit 1; }
  
  # Verify build results (abuild creates architecture-specific subdirectories)
  apk_count=$(find "$REPODEST"/repo -name "*.apk" | wc -l)
  if [ "$apk_count" -gt 0 ]; then
    echo "✓ Built $apk_count APK files under $REPODEST/repo"
    find "$REPODEST"/repo -name "*.apk" -exec ls -la {} \;
  else
    echo "ERROR: No APK files found under $REPODEST/repo" >&2
    find "$REPODEST"/repo -type f || echo "No files found in $REPODEST/repo"
    exit 1
  fi
  
  # Place the public signing key into the repo root for architecture-independent access
  if [ -f "/home/builder/.abuild/builder-6904805d.rsa.pub" ]; then
    cp /home/builder/.abuild/builder-6904805d.rsa.pub "$REPODEST/repo/packager.rsa.pub"
    echo "✓ Public key copied to $REPODEST/repo/packager.rsa.pub (architecture-independent)"
  else
    echo "WARNING: Public key /home/builder/.abuild/builder-6904805d.rsa.pub not found"
    echo "Available files in /home/builder/.abuild/:"
    ls -la /home/builder/.abuild/ || true
  fi
'

echo "✓ APK build completed successfully"