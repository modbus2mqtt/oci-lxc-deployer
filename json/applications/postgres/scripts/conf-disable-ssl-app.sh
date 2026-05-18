#!/bin/sh
# Disable SSL (and revert mTLS) in PostgreSQL configuration
#
# Overrides the shared no-op script.
# Removes the SSL and mTLS configuration blocks from postgresql.conf and
# restores the stock pg_hba.conf (password auth) when the SSL addon is
# disabled. Fully reverts to the pre-mTLS state with no data loss.
set -eu

HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"

# Sanitize hostname for volume path
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

PG_DATA_DIR="$(resolve_host_volume "$SAFE_HOST" "data" "$VM_ID")/pgdata"
PG_CONF="${PG_DATA_DIR}/postgresql.conf"
PG_HBA="${PG_DATA_DIR}/pg_hba.conf"

SSL_START="# proxvex SSL start"
SSL_END="# proxvex SSL end"
MTLS_START="# proxvex mTLS start"
MTLS_END="# proxvex mTLS end"

SSL_DISABLED="false"
PG_MTLS_DISABLED="false"

emit_result() {
  echo "[{\"id\":\"ssl_app_disabled\",\"value\":\"${SSL_DISABLED}\"},{\"id\":\"pg_mtls_disabled\",\"value\":\"${PG_MTLS_DISABLED}\"}]"
}

reload_postgres() {
  [ -z "$VM_ID" ] && return 0
  [ "$VM_ID" = "NOT_DEFINED" ] && return 0
  pct exec "$VM_ID" -- su - postgres -c "psql -c 'SELECT pg_reload_conf()'" >/dev/null 2>/dev/null || true
}

if [ ! -f "$PG_CONF" ]; then
  echo "postgresql.conf not found, nothing to disable" >&2
  emit_result
  exit 0
fi

if grep -q "$SSL_START" "$PG_CONF"; then
  sed -i "/${SSL_START}/,/${SSL_END}/d" "$PG_CONF"
  SSL_DISABLED="true"
  echo "SSL configuration removed from postgresql.conf" >&2
else
  echo "No SSL configuration found in postgresql.conf" >&2
fi

if grep -q "$MTLS_START" "$PG_CONF"; then
  sed -i "/${MTLS_START}/,/${MTLS_END}/d" "$PG_CONF"
  echo "mTLS (ssl_ca_file) removed from postgresql.conf" >&2
fi

# Restore the stock pg_hba.conf (password auth) if we ever replaced it.
# cp -p / mv -f preserved the original ownership+mode, so no chown needed.
if [ -f "${PG_HBA}.proxvex-orig" ]; then
  mv -f "${PG_HBA}.proxvex-orig" "$PG_HBA"
  chmod 600 "$PG_HBA" 2>/dev/null || true
  PG_MTLS_DISABLED="true"
  echo "Restored stock pg_hba.conf (password auth)" >&2
fi

reload_postgres
emit_result
