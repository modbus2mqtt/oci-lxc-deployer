#!/bin/sh
# Create the cert-only `gitea` LOGIN role and make it own the gitea database,
# so Gitea can authenticate (mTLS, cert CN == role) AND run its DDL
# migrations. Runs inside the postgres dependency container
# (execute_on: application:postgres), after template 187 created the database.
#
# App-specific on purpose: addon-mtls is generic and is also used by
# non-postgres apps (node-red, eclipse-mosquitto, modbus2mqtt — MQTT client
# certs only). The postgres LOGIN role is therefore NOT created by addon-mtls;
# gitea creates its own here (gitea/gitea cannot self-provision a DB role,
# unlike zitadel whose FirstInstance bootstrap creates its role/DB via the
# superuser Admin connection). This is the production equivalent of the TEST
# overlay livetest-local/applications/gitea/.../conf-init-gitea-testdb.sh.
#
# Why the owner change: PostgreSQL 15+ no longer grants CREATE on schema
# public to ordinary roles — only the DB owner may create objects there.
# Without it Gitea authenticates fine but migration fails with
# `pq: permission denied for schema public` and the container crash-loops.
#
# Idempotent: CREATE ROLE only if missing (else ensure LOGIN); ALTER DATABASE
# ... OWNER TO is a no-op when already owned.
set -eu

DB_NAME="{{ database_name }}"
[ "$DB_NAME" = "NOT_DEFINED" ] && DB_NAME=""
[ -z "$DB_NAME" ] && DB_NAME="gitea"

# Defensive: DB name allowlist (reaches psql; gitea's default is a plain
# identifier — never interpolate anything outside [A-Za-z0-9_-]).
case "$DB_NAME" in
  *[!A-Za-z0-9_-]*)
    echo "ERROR: refusing unsafe database_name '$DB_NAME'" >&2
    echo '[]'
    exit 1
    ;;
esac

if ! psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null | grep -q 1; then
  echo "ERROR: database '${DB_NAME}' does not exist — template 187 must run first" >&2
  echo '[]'
  exit 1
fi

echo "Ensuring cert-only LOGIN role 'gitea' (passwordless, idempotent)..." >&2
# Literal role name inside a DO block — NO psql `:var` (psql does not
# interpolate variables inside dollar-quoted bodies). Mirrors the proven
# conf-init-gitea-testdb.sh role logic.
psql -U postgres -v ON_ERROR_STOP=1 -f - >&2 <<'SQL'
DO $do$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gitea') THEN
    CREATE ROLE gitea LOGIN;
  ELSE
    ALTER ROLE gitea WITH LOGIN;
  END IF;
END
$do$;
SQL

echo "Setting OWNER of database '${DB_NAME}' to role 'gitea' (idempotent)..." >&2
psql -U postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"${DB_NAME}\" OWNER TO gitea" >&2

echo "gitea DB role+owner ensured (role gitea owns ${DB_NAME})" >&2
echo '[{"id":"gitea_db_owner","value":"gitea"}]'
