#!/bin/sh
# Apply SQL migrations from the uploaded tgz to the app's PostgreSQL database.
#
# Idempotent via a bookkeeping table (<slug>_data.<db_migrations_table>) that
# tracks applied files by sha256. Re-runs and upgrades only apply files that
# are new or whose content changed. Sha drift on an already-applied file is a
# hard error — surfaces accidental edits to old migrations.
#
# Framework-core SQL (00_*, 01_*, 02_*) is skipped when the `auth` schema
# already exists, so multiple zitadel-pgrst-app installations share one auth
# setup in the same database.
#
# Runs inside the postgres LXC (execute_on: application:postgres) — psql is
# available locally as the postgres OS user.
#
# Template variables:
#   app_slug             - Application slug (used for data schema name)
#   app_tgz_content      - Base64 tgz, decoded inline; we only extract bootstrap/db
#   db_migrations_table  - Bookkeeping table name (default: _proxvex_migrations)
#   database             - Target database (default: postgres)

set -eu

APP_SLUG="{{ app_slug }}"
TGZ_B64="{{ app_tgz_content }}"
MIG_TABLE="{{ db_migrations_table }}"
DATABASE="{{ database }}"

case "$MIG_TABLE" in ""|NOT_DEFINED) MIG_TABLE="_proxvex_migrations" ;; esac
case "$DATABASE" in ""|NOT_DEFINED) DATABASE="postgres" ;; esac

if [ -z "$APP_SLUG" ] || [ "$APP_SLUG" = "NOT_DEFINED" ]; then
  echo "ERROR: app_slug is required" >&2
  exit 1
fi
if [ -z "$TGZ_B64" ] || [ "$TGZ_B64" = "NOT_DEFINED" ]; then
  echo "ERROR: app_tgz_content is required" >&2
  exit 1
fi

DATA_SCHEMA="${APP_SLUG}_data"
STAGE="/var/tmp/zpa-${APP_SLUG}"

# Clean staging on every run — fresh tgz extract.
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "apply-sql-migrations: decoding tgz to $STAGE" >&2
printf '%s' "$TGZ_B64" | base64 -d | tar -xzf - -C "$STAGE" bootstrap/db || {
  echo "ERROR: failed to extract bootstrap/db from tgz" >&2
  exit 1
}

if [ ! -d "$STAGE/bootstrap/db" ]; then
  echo "ERROR: tgz does not contain bootstrap/db/" >&2
  exit 1
fi

run_sql() { psql -U postgres -d "$DATABASE" -tAc "$1" 2>&1; }
run_sql_file() { psql -U postgres -d "$DATABASE" -v ON_ERROR_STOP=1 -f "$1"; }

# Bookkeeping table lives in <slug>_data; create the schema if absent so the
# table can be created even before 330-provision-postgres-app runs. (330 is
# idempotent and will re-grant later.)
psql -U postgres -d "$DATABASE" -v ON_ERROR_STOP=1 <<SQL >&2
CREATE SCHEMA IF NOT EXISTS ${DATA_SCHEMA};
CREATE TABLE IF NOT EXISTS ${DATA_SCHEMA}.${MIG_TABLE} (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  sha256 text NOT NULL
);
SQL

# Detect whether the framework-core auth schema is already provisioned.
AUTH_EXISTS=$(run_sql "SELECT 1 FROM pg_namespace WHERE nspname='auth'")
ENSURE_PRINCIPAL_EXISTS=$(run_sql "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='auth' AND p.proname='ensure_principal'")
SKIP_CORE=false
if [ "$AUTH_EXISTS" = "1" ] && [ "$ENSURE_PRINCIPAL_EXISTS" = "1" ]; then
  SKIP_CORE=true
  echo "apply-sql-migrations: auth schema + ensure_principal already present — will skip core SQL (00/01/02_*)" >&2
fi

APPLIED=0
SKIPPED=0

for f in "$STAGE"/bootstrap/db/*.sql; do
  [ -f "$f" ] || continue
  fn=$(basename "$f")

  # Skip framework-core when auth schema is already there.
  # Match exact filenames so apps can use 02_<feature>.sql without collision.
  if [ "$SKIP_CORE" = "true" ]; then
    case "$fn" in
      00_roles.sql|01_auth_schema.sql|02_provisioning.sql)
        echo "  skip core (auth exists): $fn" >&2
        SKIPPED=$((SKIPPED + 1))
        continue
        ;;
    esac
  fi

  sha=$(sha256sum "$f" | awk '{print $1}')
  prev=$(run_sql "SELECT sha256 FROM ${DATA_SCHEMA}.${MIG_TABLE} WHERE filename='${fn}'")

  if [ -z "$prev" ]; then
    echo "  applying: $fn (sha=${sha})" >&2
    run_sql_file "$f" >&2
    psql -U postgres -d "$DATABASE" -v ON_ERROR_STOP=1 -c \
      "INSERT INTO ${DATA_SCHEMA}.${MIG_TABLE}(filename,sha256) VALUES ('${fn}','${sha}')" >&2
    APPLIED=$((APPLIED + 1))
  elif [ "$prev" = "$sha" ]; then
    echo "  already applied: $fn" >&2
    SKIPPED=$((SKIPPED + 1))
  else
    echo "ERROR: $fn already applied with sha=${prev} but tgz has sha=${sha} (drift — old migrations must not change)" >&2
    exit 1
  fi
done

# Clean staging on success.
rm -rf "$STAGE"

echo "apply-sql-migrations: ${APPLIED} applied, ${SKIPPED} skipped" >&2

cat <<EOF
[
  {"id": "migrations_applied", "value": "${APPLIED}"},
  {"id": "migrations_skipped", "value": "${SKIPPED}"}
]
EOF
