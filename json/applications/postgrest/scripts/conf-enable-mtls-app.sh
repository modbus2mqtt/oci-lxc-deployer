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
  # Swap the login role to the cert CN (PostgreSQL `cert` hba auth requires
  # the DB role to equal the client-cert CN, which is the container hostname
  # = mtls_cns default). Then append the libpq SSL query string before the
  # closing quote of the PGRST_DB_URI value. Only that line is touched.
  SSL_QS="?sslmode=verify-ca\&sslrootcert=${MTLS_PATH}/chain.pem\&sslcert=${MTLS_PATH}/cert.pem\&sslkey=${MTLS_PATH}/privkey.pem"
  sed -i -E "s#(PGRST_DB_URI: \"postgres://)\\\$\{POSTGRES_USER:-postgres\}:#\1${CN}:#" "$TMPFILE"
  sed -i -E "s#(PGRST_DB_URI: \"postgres://[^\"]*)\"#\1${SSL_QS}\"#" "$TMPFILE"
  echo "mtls: rewrote PGRST_DB_URI -> role ${CN} + verify-ca client cert ($MTLS_PATH)" >&2
fi

COMPOSE_MTLS_B64=$(base64 < "$TMPFILE" | tr -d '\n')

# --- 3. Cert perms for the non-root postgrest container (uid 1000) ---
# 161-conf-generate-mtls-certs writes the mtls subtree owned by the LXC's
# unprivileged root (e.g. host uid 100000) with the dir 0700 and privkey.pem
# 0600. The official postgrest/postgrest image runs as uid 1000, so inside
# the container it cannot traverse the 0700 dir nor read the 0600 key — libpq
# then reports the cert file as "does not exist". Fix it on the certs volume's
# host path (the LXC is not running yet, so no `pct exec`):
#   - dirs 0755 so uid 1000 can traverse,
#   - cert.pem/chain.pem 0644 (public),
#   - privkey.pem stays 0600 but chowned to the host uid that maps to the
#     container's uid 1000 (= LXC-root host uid + 1000); libpq requires the
#     key be unreadable by group/world OR owned by the reader — 0600 owned by
#     the postgrest uid satisfies it. Resolve the host path via pct/pvesm
#     (the 162 template prepends no library, so no resolve_host_volume).
CERTS_VOLID=$(pct config "$VM_ID" 2>/dev/null \
  | awk '/^mp[0-9]+:.*[ ,]mp=\/certs([, ]|$)/ { sub(/^mp[0-9]+:[[:space:]]*/,""); split($0,a,","); print a[1]; exit }')
if [ -n "$CERTS_VOLID" ]; then
  CERTS_HOST=$(pvesm path "$CERTS_VOLID" 2>/dev/null)
  MTLS_CN_DIR="$CERTS_HOST/mtls/$CN"
  if [ -n "$CERTS_HOST" ] && [ -d "$MTLS_CN_DIR" ]; then
    # LXC-root host uid (what 161 chowned the mtls dir to) + container uid 1000.
    BASE_UID=$(stat -c %u "$CERTS_HOST/mtls" 2>/dev/null || echo 100000)
    PG_UID=$((BASE_UID + 1000))
    chmod 0755 "$CERTS_HOST/mtls" "$MTLS_CN_DIR" 2>/dev/null || true
    chmod 0644 "$MTLS_CN_DIR/cert.pem" "$MTLS_CN_DIR/chain.pem" 2>/dev/null || true
    chown "${PG_UID}:${PG_UID}" "$MTLS_CN_DIR/privkey.pem" 2>/dev/null || true
    chmod 0600 "$MTLS_CN_DIR/privkey.pem" 2>/dev/null || true
    echo "mtls: perms set for postgrest uid ${PG_UID} on $MTLS_CN_DIR (dirs 0755, privkey 0600 owned ${PG_UID})" >&2
  else
    echo "mtls: WARN could not resolve certs host dir ($CERTS_HOST / $MTLS_CN_DIR) — perms not adjusted" >&2
  fi
else
  echo "mtls: WARN no /certs mp on VM $VM_ID — perms not adjusted" >&2
fi

echo "[{\"id\":\"mtls_app_enabled\",\"value\":\"true\"},{\"id\":\"compose_file\",\"value\":\"$COMPOSE_MTLS_B64\"}]"
