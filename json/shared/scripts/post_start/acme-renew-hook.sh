#!/bin/sh
# ACME certificate renewal — issue, renew, and maintain.
# Deployed by template 342 as an on-start hook into
# /etc/proxvex/on_start.d/. Runs once at deploy time
# (hook_trigger_now=true) and on every container start thereafter.
#
# Template variables ({{ ... }}) are substituted by the Spoke at deploy
# time, so no outer wrapper / heredoc trickery is needed.
#
# Exit codes:
#   0 - hook deployed + best-effort issuance attempted; renewal loop started
#   1 - setup failure: tooling install (apk/apt) failed before issuance
#
# Note: success/failure of the actual ACME issuance is NOT reflected in the
# exit code. The system carries a self-signed bootstrap placeholder
# (CN=bootstrap-placeholder) at $CERT_DIR/fullchain.pem so apps with
# listen … ssl can start before LE has issued. Verification that a real
# Let's Encrypt cert was issued belongs in the check phase
# (945-host-check-cert-issuer compares the issuer against an expected pattern).

CF_API_TOKEN="{{ CF_TOKEN }}"
ACME_SAN="{{ acme_san }}"
ACME_EMAIL="{{ acme_email }}"
CERT_DIR="{{ acme.cert_dir }}"
NEEDS_CA_CERT="{{ acme.needs_ca_cert }}"
ACME_STAGING="{{ acme_staging }}"
ALPINE_MIRROR="{{ alpine_mirror }}"
DEBIAN_MIRROR="{{ debian_mirror }}"

APP_UID="${1:-0}"
APP_GID="${2:-0}"
ACME_HOME="/root/.acme.sh"
RELOAD_SCRIPT="/etc/proxvex/reload_certificates"

# acme_san is comma-separated (e.g. "example.com,www.example.com"). The
# primary domain (first entry) is used for --list/--renew/--install-cert
# lookups, every entry is passed as a separate -d to --issue.
# Empty/NOT_DEFINED handling: addon-acme is only active when acme_san is set
# (validated by conf-write-on-start-scripts.sh), but be defensive.
[ "$ACME_SAN" = "NOT_DEFINED" ] && ACME_SAN=""
PRIMARY_DOMAIN=$(printf '%s' "$ACME_SAN" | cut -d, -f1 | tr -d ' ')
build_acme_d_args() {
  # Echoes "-d san1 -d san2 ..." with each comma-separated entry trimmed.
  printf '%s' "$ACME_SAN" | tr ',' '\n' | while IFS= read -r _san; do
    _san=$(printf '%s' "$_san" | tr -d ' ')
    [ -n "$_san" ] && printf -- '-d %s ' "$_san"
  done
}

# --- Check if renewal loop already running ---
if pgrep -f "acme-renew-loop" >/dev/null 2>&1; then
  echo "ACME renewal loop already running" >&2
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

# --- Install curl and openssl if not present ---
if ! command -v curl >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
  echo "Installing curl and openssl..." >&2
  # Wait for DNS — the on_start hook fires right after container boot,
  # before the resolver has settled, so the first apk/apt operation
  # often hits "DNS: transient error". Wait up to 20 s before retrying.
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    if getent hosts dl-cdn.alpinelinux.org >/dev/null 2>&1 \
       || getent hosts deb.debian.org >/dev/null 2>&1 \
       || nslookup dl-cdn.alpinelinux.org >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  case "$OS_TYPE" in
    alpine)
      if [ -n "$ALPINE_MIRROR" ] && [ "$ALPINE_MIRROR" != "NOT_DEFINED" ]; then
        ALPINE_VERSION=$(cut -d. -f1,2 < /etc/alpine-release 2>/dev/null)
        if [ -n "$ALPINE_VERSION" ]; then
          cat > /etc/apk/repositories <<MIRROREOF
${ALPINE_MIRROR}/v${ALPINE_VERSION}/main
${ALPINE_MIRROR}/v${ALPINE_VERSION}/community
MIRROREOF
          echo "Set Alpine mirror: $ALPINE_MIRROR" >&2
        fi
      fi
      _ok=0
      for _try in 1 2 3 4 5; do
        apk update >&2 && apk add --no-cache curl openssl >&2 && { _ok=1; break; }
        echo "apk install attempt $_try failed, retrying..." >&2
        sleep 3
      done
      [ "$_ok" -eq 1 ] || { echo "ERROR: apk install of curl/openssl failed after 5 attempts" >&2; exit 1; }
      ;;
    debian|ubuntu)
      if [ -n "$DEBIAN_MIRROR" ] && [ "$DEBIAN_MIRROR" != "NOT_DEFINED" ]; then
        if [ -f /etc/os-release ]; then
          . /etc/os-release
          CODENAME="$VERSION_CODENAME"
        fi
        if [ -z "$CODENAME" ]; then
          CODENAME="stable"
        fi
        cat > /etc/apt/sources.list <<MIRROREOF
deb ${DEBIAN_MIRROR} ${CODENAME} main
deb ${DEBIAN_MIRROR} ${CODENAME}-updates main
MIRROREOF
        echo "Set Debian mirror: $DEBIAN_MIRROR" >&2
      fi
      export DEBIAN_FRONTEND=noninteractive
      _ok=0
      for _try in 1 2 3 4 5; do
        apt-get update -qq >&2 && apt-get install -y --no-install-recommends curl openssl >&2 && { _ok=1; break; }
        echo "apt install attempt $_try failed, retrying..." >&2
        sleep 3
      done
      [ "$_ok" -eq 1 ] || { echo "ERROR: apt install of curl/openssl failed after 5 attempts" >&2; exit 1; }
      ;;
  esac
fi

# --- Install acme.sh if not present ---
if [ ! -f "$ACME_HOME/acme.sh" ]; then
  echo "Installing acme.sh..." >&2
  if [ -n "$ACME_EMAIL" ] && [ "$ACME_EMAIL" != "NOT_DEFINED" ]; then
    curl -s https://get.acme.sh | sh -s email="$ACME_EMAIL" >&2
  else
    curl -s https://get.acme.sh | sh >&2
  fi
  if [ ! -f "$ACME_HOME/acme.sh" ]; then
    echo "ERROR: Failed to install acme.sh" >&2
    exit 1
  fi
  echo "acme.sh installed successfully" >&2
fi

# --- Function: issue or renew certificate ---
acme_issue_or_renew() {
  if [ -z "$PRIMARY_DOMAIN" ]; then
    echo "ERROR: acme_san is empty — nothing to issue" >&2
    return 1
  fi
  export CF_Token="$CF_API_TOKEN"

  ACME_D_ARGS=$(build_acme_d_args)
  ACME_ARGS="--dns dns_cf ${ACME_D_ARGS}"
  if [ "$ACME_STAGING" = "true" ]; then
    ACME_ARGS="$ACME_ARGS --server letsencrypt_test"
  fi

  # Always install server cert (privkey/cert/fullchain). Optionally also the CA chain.
  INSTALL_ARGS="--key-file ${CERT_DIR}/privkey.pem --cert-file ${CERT_DIR}/cert.pem --fullchain-file ${CERT_DIR}/fullchain.pem"
  if [ "$NEEDS_CA_CERT" = "true" ]; then
    INSTALL_ARGS="$INSTALL_ARGS --ca-file ${CERT_DIR}/chain.pem"
  fi

  # Issue certificate if not yet issued for this primary domain
  if ! "$ACME_HOME/acme.sh" --list | grep -q "$PRIMARY_DOMAIN"; then
    echo "Issuing certificate for ${PRIMARY_DOMAIN} (SAN: ${ACME_SAN})..." >&2
    "$ACME_HOME/acme.sh" --issue $ACME_ARGS >&2
    ISSUE_RC=$?
    if [ $ISSUE_RC -ne 0 ] && [ $ISSUE_RC -ne 2 ]; then
      echo "ERROR: Failed to issue certificate (exit code: $ISSUE_RC)" >&2
      return 1
    fi
  else
    echo "Certificate for $PRIMARY_DOMAIN already issued, attempting renewal..." >&2
    "$ACME_HOME/acme.sh" --renew -d "$PRIMARY_DOMAIN" >&2 || true
  fi

  # Install certificate files to target directory (always keyed by primary domain)
  mkdir -p "$CERT_DIR"
  echo "Installing certificate files to $CERT_DIR..." >&2
  "$ACME_HOME/acme.sh" --install-cert -d "$PRIMARY_DOMAIN" $INSTALL_ARGS >&2
  if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install certificate files" >&2
    return 1
  fi

  # Set ownership
  if [ "$APP_UID" != "0" ] || [ "$APP_GID" != "0" ]; then
    chown -R "${APP_UID}:${APP_GID}" "$CERT_DIR" 2>/dev/null || true
  fi

  echo "Certificate files installed successfully" >&2
  return 0
}

# --- Initial certificate issuance (synchronous, best-effort) ---
# Failure here is not fatal: the bootstrap placeholder at $CERT_DIR/fullchain.pem
# keeps the app booting, the renewal loop will retry, and the check phase
# (945-host-check-cert-issuer) is where "did ACME actually succeed?" is
# verified against the expected issuer pattern.
acme_issue_or_renew || true

# --- Start background renewal loop ---
# Use absolute path /bin/sh: the on_start hook context has a sparse PATH
# (observed: `exec: line N: sh: not found` → exit 127 → renewal loop dies
# silently). Both Alpine and Debian provide /bin/sh, so an absolute path is
# portable and bypasses the PATH-lookup race entirely.
# `exec -a` (set argv[0]) is supported by both bash and busybox-ash, used
# here purely so pgrep can detect a running loop by name.
(
  exec -a acme-renew-loop /bin/sh -c '
    while true; do
      sleep 86400
      echo "[acme-renew-loop] Checking certificate renewal..." >&2
      "'"$ACME_HOME"'/acme.sh" --renew -d "'"$PRIMARY_DOMAIN"'" >&2 || true

      # Reinstall cert files (server cert always; CA chain conditional)
      INSTALL_ARGS="--key-file '"${CERT_DIR}"'/privkey.pem --cert-file '"${CERT_DIR}"'/cert.pem --fullchain-file '"${CERT_DIR}"'/fullchain.pem"
      if [ "'"$NEEDS_CA_CERT"'" = "true" ]; then
        INSTALL_ARGS="$INSTALL_ARGS --ca-file '"${CERT_DIR}"'/chain.pem"
      fi
      "'"$ACME_HOME"'/acme.sh" --install-cert -d "'"$PRIMARY_DOMAIN"'" $INSTALL_ARGS >&2 || true

      # Set ownership
      if [ "'"$APP_UID"'" != "0" ] || [ "'"$APP_GID"'" != "0" ]; then
        chown -R "'"${APP_UID}:${APP_GID}"'" "'"$CERT_DIR"'" 2>/dev/null || true
      fi

      # Trigger reload hook if present
      if [ -x "'"$RELOAD_SCRIPT"'" ]; then
        echo "[acme-renew-loop] Running reload_certificates hook..." >&2
        "'"$RELOAD_SCRIPT"'" >&2 || true
      fi
    done
  '
) &

echo "ACME renewal loop started in background (PID: $!)" >&2
