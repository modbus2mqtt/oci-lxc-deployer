#!/bin/sh
# Enable client-side mTLS for the PostgREST docker-compose application.
#
# Overrides the shared no-op script. Runs on the PVE host during pre_start,
# after 161-conf-generate-mtls-certs (client cert written to the `mtls/`
# subdir of the managed `certs` volume).
#
# 1. Bind-mounts the managed `certs` volume into the postgrest service so the
#    container's libpq can read the client cert at /certs/mtls/<CN>/.
# 2. Rewrites PGRST_DB_URI: connect as role `postgrest` (cert CN) and append
#    sslmode=verify-ca + sslcert/sslkey/sslrootcert.
#
# Client-side only: PostgreSQL-side client-cert verification is configured by
# deploying the `postgres` dependency with addon-ssl + pg_client_cert=true.
# proxvex creates NO database roles/grants — see application.md.
#
# Library functions are prepended automatically:
# - pve_sanitize_name, resolve_host_volume (pve-common.sh)
set -eu

HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"
COMPOSE_B64="{{ compose_file }}"
CERTS_B64="{{ mtls_client_certs_b64 }}"

# Skip when mTLS is not active (no signed client cert bundle present).
if [ -z "$CERTS_B64" ] || [ "$CERTS_B64" = "NOT_DEFINED" ]; then
  echo "mtls: no client cert bundle — skipping postgrest mTLS app config" >&2
  echo '[{"id":"mtls_app_enabled","value":"false"}]'
  exit 0
fi

# CN of the client cert = container hostname (mtls_cns default {{ hostname }}).
# This is also the PostgreSQL login role the operator must create.
CN="$HOSTNAME"
MTLS_PATH="/certs/mtls/${CN}"

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT
printf '%s' "$COMPOSE_B64" | base64 -d > "$TMPFILE"

# --- 1. Add the /certs bind mount to the postgrest service (idempotent) ---
if grep -q -- '- /certs:/certs:ro' "$TMPFILE"; then
  echo "mtls: postgrest already has /certs mount, skipping volume patch" >&2
else
  # The postgrest service has no volumes: key; `ports:` is unique to it.
  # Insert a volumes: block immediately before the ports: line.
  sed -i '/^    ports:$/i\
    volumes:\
      - /certs:/certs:ro' "$TMPFILE"
  echo "mtls: added /certs:/certs:ro to postgrest service" >&2
fi

# --- 2. Rewrite PGRST_DB_URI (idempotent) ---
if grep -q 'sslcert=' "$TMPFILE"; then
  echo "mtls: PGRST_DB_URI already carries client cert params — no-op" >&2
else
  # Swap the login role to `postgrest` and append the libpq SSL query string
  # before the closing quote of the PGRST_DB_URI value. Only that line.
  SSL_QS="?sslmode=verify-ca\&sslrootcert=${MTLS_PATH}/chain.pem\&sslcert=${MTLS_PATH}/cert.pem\&sslkey=${MTLS_PATH}/privkey.pem"
  sed -i -E "s#(PGRST_DB_URI: \"postgres://)\\\$\{POSTGRES_USER:-postgres\}:#\1postgrest:#" "$TMPFILE"
  sed -i -E "s#(PGRST_DB_URI: \"postgres://[^\"]*)\"#\1${SSL_QS}\"#" "$TMPFILE"
  echo "mtls: rewrote PGRST_DB_URI -> role postgrest + verify-ca client cert ($MTLS_PATH)" >&2
fi

COMPOSE_MTLS_B64=$(base64 < "$TMPFILE" | tr -d '\n')

# --- 3. Cert perms for the postgrest container ---
# The official postgrest/postgrest image runs as root, so a root-owned 0600
# private key is accepted by libpq. libpq REJECTS a group/world-readable
# sslkey, so privkey.pem MUST stay 0600 (unlike zitadel's Go client, which
# tolerates 0644). Only the public cert/chain may be loosened; directories
# must be traversable.
SAFE_HOST=$(pve_sanitize_name "$HOSTNAME")
CERTS_DIR=$(resolve_host_volume "$SAFE_HOST" "certs" "$VM_ID")
MTLS_CN_DIR="$CERTS_DIR/mtls/$CN"
if [ -d "$MTLS_CN_DIR" ]; then
  chmod 0755 "$CERTS_DIR/mtls" "$MTLS_CN_DIR" 2>/dev/null || true
  chmod 0644 "$MTLS_CN_DIR/cert.pem" "$MTLS_CN_DIR/chain.pem" 2>/dev/null || true
  chmod 0600 "$MTLS_CN_DIR/privkey.pem" 2>/dev/null || true
  echo "mtls: set perms on $MTLS_CN_DIR (privkey 0600, cert/chain 0644)" >&2
fi

echo "[{\"id\":\"mtls_app_enabled\",\"value\":\"true\"},{\"id\":\"compose_file\",\"value\":\"$COMPOSE_MTLS_B64\"}]"
