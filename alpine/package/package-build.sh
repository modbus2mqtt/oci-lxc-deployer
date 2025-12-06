#!/bin/sh
set -eu

# package-build.sh
# Container entrypoint to build an APK for a given package directory.
# Expects environment:
# - PACKAGER_PRIVKEY: private key contents (PEM)
# - PKG_NAME: package name (matches directory under $PKG_BASE)
# - PKG_BASE: base path to packages (default: alpine/package)
# - ALPINE_VERSION: optional, for logging

PKG_BASE="${PKG_BASE:-alpine/package}"
PKG_NAME="${PKG_NAME:-}"
if [ -z "$PKG_NAME" ]; then
  echo "ERROR: PKG_NAME not set" >&2
  exit 2
fi
WORKDIR="/work/$PKG_BASE/$PKG_NAME"
REPODEST="/work/alpine/repo"

if [ ! -d "$WORKDIR" ] || [ ! -f "$WORKDIR/APKBUILD" ]; then
  echo "ERROR: APKBUILD not found in $WORKDIR" >&2
  ls -la "$WORKDIR" 2>/dev/null || true
  exit 3
fi

echo "Container build for $PKG_NAME (Alpine ${ALPINE_VERSION:-unknown})"
cd "$WORKDIR"

# Install build tools
apk add --no-cache --allow-untrusted --cache-dir /var/cache/apk abuild alpine-sdk nodejs npm shadow openssl doas rsync python3 py3-psutil make build-base linux-headers udev
mkdir -p /etc/doas.d
echo 'permit nopass :dialout as root' > /etc/doas.d/doas.conf || true

# Create build user and abuild setup
if ! getent group dialout >/dev/null 2>&1; then
  addgroup -g "${HOST_GID:-1000}" dialout >/dev/null 2>&1 || true
fi
adduser -D -u "${HOST_UID:-1000}" -G dialout builder || true
addgroup builder abuild || true
mkdir -p /home/builder
chown builder:dialout /home/builder || true
mkdir -p /home/builder/.npm
chown -R builder:dialout /home/builder/.npm || true
mkdir -p /home/builder/.abuild

umask 077
# Generate abuild keys (non-interactive) and install pubkey if no PACKAGER_PRIVKEY provided
if [ -z "${PACKAGER_PRIVKEY:-}" ]; then
  PACKAGER="${PACKAGER:-builder}" abuild-keygen -a -i -n
  # Determine generated key name
  PACKAGER_KEY="$(ls /home/builder/.abuild/*.rsa 2>/dev/null | head -n1 | xargs -n1 basename || echo builder-$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n').rsa)"
else
  # Use provided private key and derive pubkey
  PACKAGER_KEY="builder-$(echo "$PACKAGER_PRIVKEY" | sha256sum | awk '{print substr($1,1,8)}').rsa"
  printf "%s" "$PACKAGER_PRIVKEY" > /home/builder/.abuild/${PACKAGER_KEY}
  chmod 600 /home/builder/.abuild/${PACKAGER_KEY}
  chown builder:dialout /home/builder/.abuild/${PACKAGER_KEY}
  openssl rsa -in /home/builder/.abuild/${PACKAGER_KEY} -pubout -out /home/builder/.abuild/${PACKAGER_KEY}.pub 2>/dev/null
  chmod 644 /home/builder/.abuild/${PACKAGER_KEY}.pub || true
  chown builder:dialout /home/builder/.abuild/${PACKAGER_KEY}.pub || true
  # Trust public key for indexing
  mkdir -p /etc/apk/keys
  cp /home/builder/.abuild/${PACKAGER_KEY}.pub "/etc/apk/keys/${PACKAGER_KEY}.pub"
fi
 ls -ls /home/builder/.abuild/*.rsa >&2
 
# Repo destination and abuild config
mkdir -p "$REPODEST"
cat >/home/builder/.abuild/abuild.conf <<EOF
PACKAGER_PRIVKEY=/home/builder/.abuild/${PACKAGER_KEY}
PACKAGER_PUBKEY=/home/builder/.abuild/${PACKAGER_KEY}.pub
KEYDIR=/etc/apk/keys
REPODEST=$REPODEST
EOF
chown -R builder:dialout /home/builder

# Run abuild
su - builder -s /bin/sh -c '
  set -e
  cd /work/'"$PKG_BASE"'/'"$PKG_NAME"'
  pwd >&2

  export REPODEST="'"$REPODEST"'"
  echo "Building APK for '"$PKG_NAME"' to '"$REPODEST"'" >&2
  export ALLOW_UNTRUSTED=1
  # Ensure abuild keys exist and pubkey installed (non-interactive)
  PACKAGER="${PACKAGER:-Builder <builder@example.com>}" abuild-keygen -a -i -n || true
   # Configure npm cache if provided
   if [ -n "${NPM_CONFIG_CACHE:-}" ]; then
     mkdir -p "${NPM_CONFIG_CACHE}"
     chown -R builder:dialout "${NPM_CONFIG_CACHE}" 2>/dev/null || true
     npm config set cache "${NPM_CONFIG_CACHE}" --global || true
   fi
  abuild checksum || true
  abuild -r
  apk_count=$(find "'"$REPODEST"'" -name "*.apk" | wc -l)
  if [ "$apk_count" -gt 0 ]; then
    echo "✓ Built $apk_count APK files directly to '"$REPODEST"'"
    find "'"$REPODEST"'" -name "*.apk" -exec ls -la {} \;
  else
    echo "ERROR: No APK files found in '"$REPODEST"'" >&2
    find "'"$REPODEST"'" -type f || echo "No files found in '"$REPODEST"'"; exit 1
  fi
'

# Copy public key to repo for convenience
cp /home/builder/.abuild/privkey.rsa.pub "$REPODEST/packager.rsa.pub" || true

echo "Build finished for $PKG_NAME"
