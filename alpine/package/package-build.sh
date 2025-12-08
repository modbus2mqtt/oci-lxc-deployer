#!/bin/sh
set -eu

# package-build.sh
# Container entrypoint to build an APK for a given package directory.
# Expects environment:
# - PACKAGER_PRIVKEY: private key contents (PEM)
# - PKG_NAME: package name (matches directory under $PKG_BASE)
# - PKG_BASE: base path to packages (default: alpine/package)
# - ALPINE_VERSION: optional, for logging
echo "Container build for $PKG_NAME (Alpine ${ALPINE_VERSION:-unknown})"
cd /work/"$PKG_NAME"
# Use default Alpine repositories unless explicitly overridden
if [ -n "${ALPINE_REPO_VER:-}" ] && [ "${USE_DEFAULT_REPOS:-0}" != "1" ]; then
  ALPINE_REPO_VER="v${ALPINE_VERSION}"
  cat > /etc/apk/repositories <<-REPO
https://mirror.init7.net/alpinelinux/${ALPINE_REPO_VER}/main
https://mirror.init7.net/alpinelinux/${ALPINE_REPO_VER}/community
REPO
fi
# Install build tools (avoid explicit cache-dir to prevent CI cache warnings)
mkdir -p /var/cache/apk || true
apk add --no-cache --allow-untrusted abuild alpine-sdk nodejs npm shadow openssl doas rsync python3 py3-psutil make build-base linux-headers udev
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
rm -rf  /work/repo/work || true
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
rm -f "/work/repo/lxc-manager/APKINDEX.tar.gz" || true

# Repo destination and abuild config
cat >/home/builder/.abuild/abuild.conf <<EOF
PACKAGER_PRIVKEY=/home/builder/.abuild/${PACKAGER_KEY}
PACKAGER_PUBKEY=/home/builder/.abuild/${PACKAGER_KEY}.pub
KEYDIR=/etc/apk/keys
REPODEST=/work/repo
repo=lxc-manager
EOF
# Ensure root (index/sign) uses the same config and keyring
cat >/etc/abuild.conf <<EOF
PACKAGER_PRIVKEY=/home/builder/.abuild/${PACKAGER_KEY}
KEYDIR=/etc/apk/keys
REPODEST=/work/repo
repo=lxc-manager
EOF
# Make keyring visible to all apk/abuild invocations (builder and root phases)
export ABUILD_KEYDIR=/etc/apk/keys
export APK_KEYS=/etc/apk/keys
chown -R builder:dialout /home/builder

# Run abuild
su - builder -s /bin/sh -c '
  set -e
  cd /work/"'$PKG_NAME'"
  export ALLOW_UNTRUSTED=1
  export REPODEST=/work/repo
  export repo=lxc-manager
  # Ensure abuild uses the correct keyring for verification
  export ABUILD_KEYDIR=/etc/apk/keys
   # Configure npm cache if provided
   if [ -n "${NPM_CONFIG_CACHE:-}" ]; then
     mkdir -p "${NPM_CONFIG_CACHE}"
     chown -R builder:dialout "${NPM_CONFIG_CACHE}" 2>/dev/null || true
     npm config set cache "${NPM_CONFIG_CACHE}" --global || true
   fi
  echo "Running checksum for '"$PKG_NAME"'..."
  abuild checksum || true
  echo "Running abuild -P for '"$PKG_NAME"' (build + package to REPODEST)..."
  abuild -r -P "/work/repo" validate builddeps clean fetch \
	unpack prepare mkusers build check rootpkg
'
# Collect built artifacts: with -P, abuild already placed them under REPODEST/repo
   echo "Place the apk file directly in work/repo" >&2
   find /work/repo -name "*.apk" -exec mv {} /work/repo \; >&2
   
cp /home/builder/.abuild/${PACKAGER_KEY}.pub "/work/repo/packager.rsa.pub" || true
# Ensure repo artifacts are world-readable for CI artifact collection
chmod -R a+rX /work/repo || true

echo "Build finished for $PKG_NAME"
