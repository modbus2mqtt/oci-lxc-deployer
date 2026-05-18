#!/bin/sh
# TEST-ONLY DB role init for livetest gitea scenarios.
# Runs inside the postgres dependency container (execute_on: application:postgres),
# before gitea starts, after template 187 created the `gitea` database.
# Idempotent.
#
# Production proxvex creates NO database SQL — this exists solely so cert-only
# gitea livetest scenarios have a working owner role (the operator does this in
# real deployments; see json/applications/gitea/application.md ## Database setup).
#
# Creates:
#   - role `gitea` LOGIN, no password (mTLS cert CN == DB role)
#   - ALTER DATABASE <database_name> OWNER TO gitea  (gitea runs DDL migrations)
#
# Harmless for non-mTLS gitea scenarios: they connect as `postgres` and never
# use the role, but creating it is idempotent and side-effect free.

DB_NAME="{{ database_name }}"
[ "$DB_NAME" = "NOT_DEFINED" ] && DB_NAME=""
[ -z "$DB_NAME" ] && DB_NAME="gitea"

echo "livetest: initializing gitea test DB role (db=${DB_NAME})..." >&2

psql -U postgres -v ON_ERROR_STOP=1 -v dbname="$DB_NAME" -f - >&2 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gitea') THEN
    CREATE ROLE gitea LOGIN;
  ELSE
    ALTER ROLE gitea WITH LOGIN;
  END IF;
END $$;

ALTER DATABASE :"dbname" OWNER TO gitea;
SQL

echo "livetest: gitea test DB role ready (role gitea owns ${DB_NAME}, no password)" >&2
