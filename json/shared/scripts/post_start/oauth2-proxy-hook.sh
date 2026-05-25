#!/bin/sh
# OAuth2-Proxy JWT-Bearer hook.
# Deployed by template 344 as an on-start hook into /etc/proxvex/on_start.d/.
# Runs once at deploy (hook_trigger_now=true) and on every container start
# thereafter via the on_start_container dispatcher.
#
# Template variables ({{ ... }}) are substituted by the Spoke at deploy time,
# so no outer wrapper / heredoc trickery is needed.
#
# Behaviour:
#   1. Lazy-installs oauth2-proxy via the OS package manager (apk community
#      or apt backports).
#   2. Detects whether /etc/ssl/addon/{fullchain,privkey}.pem are present and
#      starts oauth2-proxy in HTTPS mode if so, otherwise HTTP.
#   3. Sets iptables rules so the application's internal port is loopback-only
#      (oauth2-proxy in the same LXC is the only way in).
#   4. Launches oauth2-proxy in background with --skip-jwt-bearer-tokens=true,
#      configured to validate against Zitadel-JWKS for `bearer_audience_client_id`.
#
# Idempotent: if oauth2-proxy is already running (pgrep), exits early.

BEARER_AUDIENCE_CLIENT_ID="{{ bearer_audience_client_id }}"
BEARER_LISTEN_PORT="{{ bearer_listen_port }}"
BEARER_UPSTREAM_PORT="{{ bearer_upstream_port }}"
HTTP_PORT="{{ http_port }}"
OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
ALPINE_MIRROR="{{ alpine_mirror }}"
DEBIAN_MIRROR="{{ debian_mirror }}"

# Normalize NOT_DEFINED sentinels.
[ "$ALPINE_MIRROR" = "NOT_DEFINED" ] && ALPINE_MIRROR=""
[ "$DEBIAN_MIRROR" = "NOT_DEFINED" ] && DEBIAN_MIRROR=""

# Fall back to http_port when bearer_upstream_port wasn't resolved. The addon's
# property default `{{ http_port }}` doesn't get substituted inside property
# defaults, so we have to do the fallback at script-runtime.
if [ -z "$BEARER_UPSTREAM_PORT" ] || [ "$BEARER_UPSTREAM_PORT" = "NOT_DEFINED" ]; then
  if [ -n "$HTTP_PORT" ] && [ "$HTTP_PORT" != "NOT_DEFINED" ]; then
    BEARER_UPSTREAM_PORT="$HTTP_PORT"
  else
    echo "ERROR: neither bearer_upstream_port nor http_port is set" >&2
    exit 1
  fi
fi

APP_UID="${1:-0}"
APP_GID="${2:-0}"
CERT_DIR="/etc/ssl/addon"

if [ -z "$BEARER_AUDIENCE_CLIENT_ID" ] || [ "$BEARER_AUDIENCE_CLIENT_ID" = "NOT_DEFINED" ]; then
  echo "ERROR: bearer_audience_client_id is empty — addon-oauth2-proxy pre_start did not run" >&2
  exit 1
fi
if [ -z "$OIDC_ISSUER_URL" ] || [ "$OIDC_ISSUER_URL" = "NOT_DEFINED" ]; then
  echo "ERROR: oidc_issuer_url is empty — Zitadel registration produced no issuer" >&2
  exit 1
fi

# --- Already running? exit early (idempotent on container restart) ---
if pgrep -x oauth2-proxy >/dev/null 2>&1 || pgrep -x oauth2_proxy >/dev/null 2>&1; then
  echo "oauth2-proxy already running" >&2
  exit 0
fi

# --- Detect OS ---
OS_TYPE=""
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_TYPE="$ID"
elif command -v apk >/dev/null 2>&1; then
  OS_TYPE="alpine"
elif command -v apt-get >/dev/null 2>&1; then
  OS_TYPE="debian"
fi

# --- Lazy install of oauth2-proxy ---
# Strategy:
#   1. Try OS package manager (apk/apt). Many distros don't ship it (Alpine
#      3.23 doesn't have it; Ubuntu 22.04 doesn't either; Debian 12 needs
#      bookworm-backports). When that fails we fall back to:
#   2. Download the pinned binary release from GitHub. Stored in
#      /var/lib/oauth2-proxy/bin/ so it survives container restarts (volume
#      is the LXC rootfs — fresh containers re-download once, then cache).
OAUTH2_BIN=""
if command -v oauth2-proxy >/dev/null 2>&1; then
  OAUTH2_BIN=$(command -v oauth2-proxy)
elif command -v oauth2_proxy >/dev/null 2>&1; then
  OAUTH2_BIN=$(command -v oauth2_proxy)
elif [ -x /var/lib/oauth2-proxy/bin/oauth2-proxy ]; then
  OAUTH2_BIN=/var/lib/oauth2-proxy/bin/oauth2-proxy
fi

if [ -z "$OAUTH2_BIN" ]; then
  echo "Installing oauth2-proxy..." >&2

  # Try OS package manager first (idempotent — apk add is no-op if installed)
  case "$OS_TYPE" in
    alpine)
      if [ -n "$ALPINE_MIRROR" ]; then
        ALPINE_VERSION=$(cut -d. -f1,2 < /etc/alpine-release 2>/dev/null)
        if [ -n "$ALPINE_VERSION" ]; then
          cat > /etc/apk/repositories <<MIRROREOF
${ALPINE_MIRROR}/v${ALPINE_VERSION}/main
${ALPINE_MIRROR}/v${ALPINE_VERSION}/community
MIRROREOF
        fi
      fi
      apk update >&2 2>/dev/null || true
      apk add --no-cache oauth2-proxy >&2 2>/dev/null || apk add --no-cache oauth2_proxy >&2 2>/dev/null || true
      ;;
    debian|ubuntu)
      if [ -n "$DEBIAN_MIRROR" ]; then
        . /etc/os-release 2>/dev/null
        CODENAME="${VERSION_CODENAME:-stable}"
        cat > /etc/apt/sources.list <<MIRROREOF
deb ${DEBIAN_MIRROR} ${CODENAME} main
deb ${DEBIAN_MIRROR} ${CODENAME}-backports main
MIRROREOF
      fi
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq >&2 2>/dev/null || true
      apt-get install -y --no-install-recommends oauth2-proxy >&2 2>/dev/null || true
      ;;
  esac

  # Re-check after package-manager attempt
  if command -v oauth2-proxy >/dev/null 2>&1; then
    OAUTH2_BIN=$(command -v oauth2-proxy)
  elif command -v oauth2_proxy >/dev/null 2>&1; then
    OAUTH2_BIN=$(command -v oauth2_proxy)
  fi
fi

# Fallback: download pinned release from GitHub
if [ -z "$OAUTH2_BIN" ]; then
  OAUTH2_PROXY_VERSION="7.6.0"
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
  esac
  URL="https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v${OAUTH2_PROXY_VERSION}/oauth2-proxy-v${OAUTH2_PROXY_VERSION}.linux-${ARCH}.tar.gz"
  echo "Downloading oauth2-proxy from $URL" >&2

  # Need wget or curl — install if missing
  if ! command -v wget >/dev/null 2>&1 && ! command -v curl >/dev/null 2>&1; then
    case "$OS_TYPE" in
      alpine) apk add --no-cache wget >&2 2>/dev/null || apk add --no-cache curl >&2 2>/dev/null ;;
      debian|ubuntu) apt-get install -y --no-install-recommends wget >&2 2>/dev/null || apt-get install -y --no-install-recommends curl >&2 2>/dev/null ;;
    esac
  fi

  mkdir -p /var/lib/oauth2-proxy/bin
  cd /tmp || exit 1
  if command -v wget >/dev/null 2>&1; then
    wget -q "$URL" -O o2p.tar.gz || { echo "ERROR: wget failed for $URL" >&2; exit 1; }
  else
    curl -sLfo o2p.tar.gz "$URL" || { echo "ERROR: curl failed for $URL" >&2; exit 1; }
  fi
  tar xzf o2p.tar.gz || { echo "ERROR: extract failed" >&2; exit 1; }
  mv "oauth2-proxy-v${OAUTH2_PROXY_VERSION}.linux-${ARCH}/oauth2-proxy" /var/lib/oauth2-proxy/bin/oauth2-proxy
  chmod +x /var/lib/oauth2-proxy/bin/oauth2-proxy
  rm -rf o2p.tar.gz "oauth2-proxy-v${OAUTH2_PROXY_VERSION}.linux-${ARCH}"
  OAUTH2_BIN=/var/lib/oauth2-proxy/bin/oauth2-proxy
fi

if [ -z "$OAUTH2_BIN" ] || [ ! -x "$OAUTH2_BIN" ]; then
  echo "ERROR: oauth2-proxy binary not found after install attempts" >&2
  exit 1
fi
echo "oauth2-proxy binary: $OAUTH2_BIN" >&2

# --- Runtime detection: HTTPS or HTTP listener? ---
if [ -r "$CERT_DIR/fullchain.pem" ] && [ -r "$CERT_DIR/privkey.pem" ]; then
  LISTEN_FLAGS="--https-address=0.0.0.0:${BEARER_LISTEN_PORT} \
                --tls-cert-file=${CERT_DIR}/fullchain.pem \
                --tls-key-file=${CERT_DIR}/privkey.pem"
  echo "oauth2-proxy: HTTPS mode on :${BEARER_LISTEN_PORT}" >&2
else
  LISTEN_FLAGS="--http-address=0.0.0.0:${BEARER_LISTEN_PORT}"
  echo "oauth2-proxy: HTTP mode on :${BEARER_LISTEN_PORT} (no certs in ${CERT_DIR})" >&2
fi

# --- iptables: lock app's internal port to loopback only ---
# Prevents direct cluster-internal access to the application bypassing
# oauth2-proxy. Same pattern as ssl-proxy.sh blocks the HTTP port when in
# proxy mode.
if command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -i lo -p tcp --dport "${BEARER_UPSTREAM_PORT}" -j ACCEPT 2>/dev/null || \
    iptables -I INPUT -i lo -p tcp --dport "${BEARER_UPSTREAM_PORT}" -j ACCEPT
  iptables -C INPUT -p tcp --dport "${BEARER_UPSTREAM_PORT}" -j DROP 2>/dev/null || \
    iptables -A INPUT -p tcp --dport "${BEARER_UPSTREAM_PORT}" -j DROP
  echo "iptables: app port ${BEARER_UPSTREAM_PORT} locked to loopback" >&2
else
  echo "WARN: iptables not available — app port ${BEARER_UPSTREAM_PORT} remains reachable from the cluster" >&2
fi

# --- Generate cookie_secret (required by oauth2-proxy even in JWT-only mode) ---
# Fresh per container start. The JWT path doesn't use it for session cookies,
# but oauth2-proxy refuses to start without one. Must be exactly 16, 24, or 32
# characters (string length, not base64-decoded bytes) for AES-128/192/256.
# `openssl rand -base64 24` produces a 32-char base64 string (24 raw bytes).
if command -v openssl >/dev/null 2>&1; then
  COOKIE_SECRET=$(openssl rand -base64 24 | tr -d '\n')
else
  # Fallback: 32 hex chars = 16 raw bytes (still valid for AES-128).
  COOKIE_SECRET=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
fi

# --- Launch oauth2-proxy in background ---
# --skip-jwt-bearer-tokens=true:    accept and validate Bearer JWTs from
#                                   Authorization header, no browser challenge.
# --extra-jwt-issuers:              <issuer>=<audience>; the audience must
#                                   appear in the JWT's aud claim.
# --skip-provider-button=true:      no browser HTML for the OIDC flow (we
#                                   intentionally don't do browser auth here).
# --email-domains='*':              required pattern; we don't filter on email.
# --client-id/--client-secret:      pro forma; not used for inbound JWT
#                                   validation. We populate them with the API
#                                   app's clientId + a dummy secret.
# --skip-oidc-discovery + manually supplied endpoints:
# Without this, oauth2-proxy crashes at startup if Zitadel's discovery
# endpoint isn't reachable. With it, oauth2-proxy starts immediately and
# only contacts Zitadel-JWKS when a JWT arrives (which is the right
# laziness for a JWT-Bearer-only proxy). Login/redeem URLs are required by
# oauth2-proxy's config validation but are unused in --skip-jwt-bearer-tokens
# mode (we never do a browser flow).
${OAUTH2_BIN} ${LISTEN_FLAGS} \
  --provider=oidc \
  --oidc-issuer-url="${OIDC_ISSUER_URL}" \
  --skip-oidc-discovery=true \
  --oidc-jwks-url="${OIDC_ISSUER_URL}/oauth/v2/keys" \
  --login-url="${OIDC_ISSUER_URL}/oauth/v2/authorize" \
  --redeem-url="${OIDC_ISSUER_URL}/oauth/v2/token" \
  --upstream="http://127.0.0.1:${BEARER_UPSTREAM_PORT}" \
  --skip-jwt-bearer-tokens=true \
  --extra-jwt-issuers="${OIDC_ISSUER_URL}=${BEARER_AUDIENCE_CLIENT_ID}" \
  --client-id="${BEARER_AUDIENCE_CLIENT_ID}" \
  --client-secret=dummy \
  --cookie-secret="${COOKIE_SECRET}" \
  --email-domain='*' \
  --skip-provider-button=true \
  >/var/log/oauth2-proxy.log 2>&1 &

OAUTH2_PID=$!
echo "oauth2-proxy started (PID ${OAUTH2_PID})" >&2

# Brief readiness check — don't block startup, just log if it crashed immediately.
sleep 1
if kill -0 "$OAUTH2_PID" 2>/dev/null; then
  echo "oauth2-proxy alive after 1s" >&2
else
  echo "ERROR: oauth2-proxy exited immediately. Check /var/log/oauth2-proxy.log:" >&2
  tail -20 /var/log/oauth2-proxy.log >&2 2>/dev/null || true
  exit 1
fi
