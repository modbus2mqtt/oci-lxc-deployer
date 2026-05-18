#!/bin/sh
# Enable SSL (and optionally client-certificate / mTLS auth) in PostgreSQL.
#
# Overrides the shared no-op script.
# Runs on PVE host during pre_start phase.
#
# Two modes depending on database state:
#   1. Existing DB (postgresql.conf exists): edit config directly
#   2. Fresh install (no postgresql.conf): write initdb script for first start
#
# mTLS (server-side client-cert verification) is gated by pg_client_cert:
#   - postgresql.conf gets a managed `ssl_ca_file` block (needs ssl = on)
#   - pg_hba.conf is replaced by the rendered pg_hba_content (cert-only by
#     default; user-overridable). The stock file is backed up once so a later
#     disable / toggle-off can fully revert to password auth.
set -eu

HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"
UID_VAL="{{ uid }}"
GID_VAL="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"
PG_CLIENT_CERT="{{ pg_client_cert }}"
PG_HBA_B64="{{ pg_hba_content }}"

[ "$PG_CLIENT_CERT" = "NOT_DEFINED" ] && PG_CLIENT_CERT="false"
[ "$PG_HBA_B64" = "NOT_DEFINED" ] && PG_HBA_B64=""

# Compute effective ownership (prefer mapped values for unprivileged containers)
EFFECTIVE_UID="$UID_VAL"
EFFECTIVE_GID="$GID_VAL"
[ -n "$MAPPED_UID" ] && [ "$MAPPED_UID" != "NOT_DEFINED" ] && EFFECTIVE_UID="$MAPPED_UID"
[ -n "$MAPPED_GID" ] && [ "$MAPPED_GID" != "NOT_DEFINED" ] && EFFECTIVE_GID="$MAPPED_GID"

# Sanitize hostname for volume path
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

CERTS_DIR=$(resolve_host_volume "$SAFE_HOST" "certs" "$VM_ID")
PG_DATA_DIR="$(resolve_host_volume "$SAFE_HOST" "data" "$VM_ID")/pgdata"
PG_CONF="${PG_DATA_DIR}/postgresql.conf"
PG_HBA="${PG_DATA_DIR}/pg_hba.conf"
INITDB_DIR=$(resolve_host_volume "$SAFE_HOST" "initdb" "$VM_ID")

SSL_START="# proxvex SSL start"
SSL_END="# proxvex SSL end"
MTLS_START="# proxvex mTLS start"
MTLS_END="# proxvex mTLS end"

SSL_ENABLED="false"
PG_MTLS_ENABLED="false"

emit_result() {
  echo "[{\"id\":\"ssl_app_enabled\",\"value\":\"${SSL_ENABLED}\"},{\"id\":\"pg_mtls_enabled\",\"value\":\"${PG_MTLS_ENABLED}\"}]"
}

# Best-effort reload so a running container picks up pg_hba.conf / ssl_ca_file
# changes without a restart (both are SIGHUP-only GUCs). Pre-first-boot this is
# a harmless no-op (container not running yet).
reload_postgres() {
  [ -z "$VM_ID" ] && return 0
  [ "$VM_ID" = "NOT_DEFINED" ] && return 0
  pct exec "$VM_ID" -- su - postgres -c "psql -c 'SELECT pg_reload_conf()'" >/dev/null 2>/dev/null || true
}

# Write the managed pg_hba.conf from the rendered (base64) content, backing up
# the stock file once so disable/toggle-off can restore password auth.
write_managed_pg_hba() {
  if [ -z "$PG_HBA_B64" ]; then
    echo "mtls: pg_hba_content empty — cannot enforce cert auth" >&2
    return 1
  fi
  if [ -f "$PG_HBA" ] && [ ! -f "${PG_HBA}.proxvex-orig" ]; then
    cp -p "$PG_HBA" "${PG_HBA}.proxvex-orig"
    echo "mtls: backed up stock pg_hba.conf to ${PG_HBA}.proxvex-orig" >&2
  fi
  if ! echo "$PG_HBA_B64" | base64 -d > "$PG_HBA" 2>/dev/null; then
    echo "mtls: failed to decode pg_hba_content — leaving pg_hba.conf untouched" >&2
    return 1
  fi
  chown "${EFFECTIVE_UID}:${EFFECTIVE_GID}" "$PG_HBA" 2>/dev/null || true
  chmod 600 "$PG_HBA" 2>/dev/null || true
  echo "mtls: wrote managed pg_hba.conf (cert auth)" >&2
}

# Restore the stock pg_hba.conf if we previously replaced it.
restore_stock_pg_hba() {
  if [ -f "${PG_HBA}.proxvex-orig" ]; then
    mv -f "${PG_HBA}.proxvex-orig" "$PG_HBA"
    chown "${EFFECTIVE_UID}:${EFFECTIVE_GID}" "$PG_HBA" 2>/dev/null || true
    chmod 600 "$PG_HBA" 2>/dev/null || true
    echo "mtls: restored stock pg_hba.conf (password auth)" >&2
  fi
}

# ── Mode 1: Existing database ──────────────────────────────────────
if [ -f "$PG_CONF" ]; then
  # Remove existing SSL + mTLS blocks (clean slate)
  sed -i "/${SSL_START}/,/${SSL_END}/d" "$PG_CONF"
  sed -i "/${MTLS_START}/,/${MTLS_END}/d" "$PG_CONF"

  if [ -f "${CERTS_DIR}/fullchain.pem" ] && [ -f "${CERTS_DIR}/privkey.pem" ]; then
    cat >> "$PG_CONF" <<EOF
${SSL_START}
ssl = on
ssl_cert_file = '/certs/fullchain.pem'
ssl_key_file = '/certs/privkey.pem'
${SSL_END}
EOF
    SSL_ENABLED="true"
    echo "SSL enabled in postgresql.conf" >&2

    if [ "$PG_CLIENT_CERT" = "true" ] && [ -f "${CERTS_DIR}/chain.pem" ]; then
      cat >> "$PG_CONF" <<EOF
${MTLS_START}
ssl_ca_file = '/certs/chain.pem'
${MTLS_END}
EOF
      if write_managed_pg_hba; then
        PG_MTLS_ENABLED="true"
        echo "mTLS enabled (ssl_ca_file + managed pg_hba.conf)" >&2
      else
        # Roll back to a consistent password-auth state: drop the ssl_ca_file
        # block and restore the stock pg_hba.conf so we never end up requiring
        # client certs without a usable CA (would lock out all TCP clients).
        sed -i "/${MTLS_START}/,/${MTLS_END}/d" "$PG_CONF"
        restore_stock_pg_hba
        echo "mtls: pg_hba write failed — mTLS NOT enabled" >&2
      fi
    else
      restore_stock_pg_hba
      if [ "$PG_CLIENT_CERT" = "true" ]; then
        echo "mtls: pg_client_cert=true but ${CERTS_DIR}/chain.pem missing — mTLS NOT enabled" >&2
      fi
    fi
  else
    echo "Certs not found, SSL not enabled" >&2
    restore_stock_pg_hba
  fi

  reload_postgres
  emit_result
  exit 0
fi

# ── Mode 2: Fresh install (write initdb script) ────────────────────
if [ ! -d "$INITDB_DIR" ]; then
  echo "initdb volume directory not found at $INITDB_DIR" >&2
  emit_result
  exit 0
fi

TARGET="${INITDB_DIR}/enable-ssl.sh"

cat > "$TARGET" <<SSLEOF
#!/bin/sh
# Enable SSL (and optionally mTLS) for PostgreSQL (conditional)
# Runs during first-time initialization (docker-entrypoint-initdb.d)

if [ -f /certs/fullchain.pem ] && [ -f /certs/privkey.pem ]; then
  chmod 600 /certs/privkey.pem

  cat >> "\$PGDATA/postgresql.conf" <<EOF

${SSL_START}
ssl = on
ssl_cert_file = '/certs/fullchain.pem'
ssl_key_file = '/certs/privkey.pem'
${SSL_END}
EOF

  if [ "${PG_CLIENT_CERT}" = "true" ] && [ -f /certs/chain.pem ]; then
    cat >> "\$PGDATA/postgresql.conf" <<EOF

${MTLS_START}
ssl_ca_file = '/certs/chain.pem'
${MTLS_END}
EOF

    if [ ! -f "\$PGDATA/pg_hba.conf.proxvex-orig" ]; then
      cp -p "\$PGDATA/pg_hba.conf" "\$PGDATA/pg_hba.conf.proxvex-orig"
    fi
    echo '${PG_HBA_B64}' | base64 -d > "\$PGDATA/pg_hba.conf"
    chmod 600 "\$PGDATA/pg_hba.conf"
  fi
fi
SSLEOF

chmod 755 "$TARGET"
chown "${EFFECTIVE_UID}:${EFFECTIVE_GID}" "$TARGET" 2>/dev/null || true

SSL_ENABLED="true"
[ "$PG_CLIENT_CERT" = "true" ] && [ -n "$PG_HBA_B64" ] && PG_MTLS_ENABLED="true"
echo "Wrote enable-ssl.sh to $TARGET (pg_client_cert=${PG_CLIENT_CERT})" >&2
emit_result
