#!/bin/sh
# Provision PostgreSQL schemas and roles for an application
#
# Creates:
#   - Data schema: <app_name>_data
#   - App user: <app_name>_app with app_password
#
# With PostgREST (with_postgrest=true):
#   - API schema: <app_name>_api
#   - Shared authenticator login role: ${DB_LOGIN_ROLE} (default api_login, created once, reused)
#   - Anon role: <app_name>_anon (read-only)
#   - User role: <app_name>_user (full access)
#
# Requires:
#   - app_name: Application name (required)
#   - app_password: Password for app user (default: app123)
#   - with_postgrest: Create PostgREST roles (default: false)
#   - api_login_password: Password for the authenticator role (default: api_login_123)
#   - db_login_role: Authenticator role name (default: api_login)
#   - database: Target database (default: postgres)
#
# Output: JSON to stdout (logs to stderr)

APP_NAME="{{ app_name }}"
APP_PASSWORD="{{ app_password }}"
WITH_POSTGREST="{{ with_postgrest }}"
API_LOGIN_PASSWORD="{{ api_login_password }}"
DB_LOGIN_ROLE="{{ db_login_role }}"
DATABASE="{{ database }}"

# Defaults
APP_PASSWORD="${APP_PASSWORD:-app123}"
WITH_POSTGREST="${WITH_POSTGREST:-false}"
API_LOGIN_PASSWORD="${API_LOGIN_PASSWORD:-api_login_123}"
case "$DB_LOGIN_ROLE" in ""|NOT_DEFINED) DB_LOGIN_ROLE="api_login" ;; esac
DATABASE="${DATABASE:-postgres}"

# Validate required parameters
if [ -z "$APP_NAME" ] || [ "$APP_NAME" = "NOT_DEFINED" ]; then
  echo "Error: app_name is required" >&2
  exit 1
fi

echo "Provisioning PostgreSQL for app: $APP_NAME in database: $DATABASE" >&2

# Run SQL command and capture output
run_sql() {
  psql -U postgres -d "$DATABASE" -tAc "$1" 2>&1
}

run_sql_file() {
  psql -U postgres -d "$DATABASE" -f - 2>&1
}

# Check if role exists
role_exists() {
  result=$(run_sql "SELECT 1 FROM pg_roles WHERE rolname='$1'")
  [ "$result" = "1" ]
}

# Check if schema exists
schema_exists() {
  result=$(run_sql "SELECT 1 FROM pg_namespace WHERE nspname='$1'")
  [ "$result" = "1" ]
}

# Create app user, or re-sync its password if it already exists.
# Idempotent password re-sync is required: when the postgres data volume
# survives a rebuild but the app's stack secret was regenerated, an existing
# role keeps its OLD password while the app connects with the NEW one →
# "password authentication failed" and the app container crash-loops (e.g.
# gitea; same class as the zitadel postgres-auth livetest finding). ALTER …
# PASSWORD converges the role to the authoritative stack value on every
# (re)deploy/reconfigure instead of silently skipping.
if role_exists "${APP_NAME}_app"; then
  echo "User ${APP_NAME}_app exists — re-syncing password to current stack value" >&2
  run_sql "ALTER USER ${APP_NAME}_app WITH PASSWORD '${APP_PASSWORD}'" >&2
else
  echo "Creating user ${APP_NAME}_app..." >&2
  run_sql "CREATE USER ${APP_NAME}_app WITH PASSWORD '${APP_PASSWORD}'" >&2
fi

# Create data schema if not exists
if schema_exists "${APP_NAME}_data"; then
  echo "Schema ${APP_NAME}_data already exists" >&2
else
  echo "Creating schema ${APP_NAME}_data..." >&2
  run_sql "CREATE SCHEMA ${APP_NAME}_data" >&2
fi

# Grant privileges on data schema
echo "Granting privileges on ${APP_NAME}_data..." >&2
run_sql_file >&2 <<EOF
GRANT CONNECT ON DATABASE ${DATABASE} TO ${APP_NAME}_app;
GRANT USAGE ON SCHEMA ${APP_NAME}_data TO ${APP_NAME}_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${APP_NAME}_data TO ${APP_NAME}_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${APP_NAME}_data TO ${APP_NAME}_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_NAME}_data GRANT ALL PRIVILEGES ON TABLES TO ${APP_NAME}_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_NAME}_data GRANT ALL PRIVILEGES ON SEQUENCES TO ${APP_NAME}_app;
ALTER USER ${APP_NAME}_app SET search_path TO ${APP_NAME}_data, public;
EOF

API_SCHEMA=""
API_SCHEMAS_LIST=""

# PostgREST setup
if [ "$WITH_POSTGREST" = "true" ]; then
  echo "Setting up PostgREST roles (authenticator role: ${DB_LOGIN_ROLE})..." >&2

  # Create shared authenticator role if not exists
  if role_exists "${DB_LOGIN_ROLE}"; then
    echo "Role ${DB_LOGIN_ROLE} already exists" >&2
  else
    echo "Creating shared ${DB_LOGIN_ROLE} authenticator role..." >&2
    run_sql_file >&2 <<EOF
CREATE ROLE ${DB_LOGIN_ROLE} NOINHERIT LOGIN PASSWORD '${API_LOGIN_PASSWORD}';
CREATE ROLE api_anon NOLOGIN;
GRANT api_anon TO ${DB_LOGIN_ROLE};
EOF
  fi

  # Create API schema if not exists
  if schema_exists "${APP_NAME}_api"; then
    echo "Schema ${APP_NAME}_api already exists" >&2
  else
    echo "Creating schema ${APP_NAME}_api..." >&2
    run_sql "CREATE SCHEMA ${APP_NAME}_api" >&2
  fi

  # Create app-specific roles if not exist
  if ! role_exists "${APP_NAME}_anon"; then
    echo "Creating role ${APP_NAME}_anon..." >&2
    run_sql "CREATE ROLE ${APP_NAME}_anon NOLOGIN" >&2
  fi

  if ! role_exists "${APP_NAME}_user"; then
    echo "Creating role ${APP_NAME}_user..." >&2
    run_sql "CREATE ROLE ${APP_NAME}_user NOLOGIN" >&2
  fi

  # Grant role switching and schema privileges
  echo "Granting PostgREST privileges..." >&2
  run_sql_file >&2 <<EOF
GRANT ${APP_NAME}_anon TO ${DB_LOGIN_ROLE};
GRANT ${APP_NAME}_user TO ${DB_LOGIN_ROLE};
GRANT CONNECT ON DATABASE ${DATABASE} TO ${DB_LOGIN_ROLE};
GRANT USAGE ON SCHEMA ${APP_NAME}_api TO ${APP_NAME}_anon, ${APP_NAME}_user;
GRANT SELECT ON ALL TABLES IN SCHEMA ${APP_NAME}_api TO ${APP_NAME}_anon;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${APP_NAME}_api TO ${APP_NAME}_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${APP_NAME}_api TO ${APP_NAME}_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_NAME}_api GRANT SELECT ON TABLES TO ${APP_NAME}_anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_NAME}_api GRANT ALL PRIVILEGES ON TABLES TO ${APP_NAME}_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_NAME}_api GRANT ALL PRIVILEGES ON SEQUENCES TO ${APP_NAME}_user;
EOF

  API_SCHEMA="${APP_NAME}_api"

  # Get all API schemas in this database
  API_SCHEMAS_LIST=$(run_sql "SELECT string_agg(nspname, ',') FROM pg_namespace WHERE nspname LIKE '%_api'")
fi

echo "Provisioning complete!" >&2

# Output JSON
cat <<EOF
[
  {"id": "app_user", "value": "${APP_NAME}_app"},
  {"id": "data_schema", "value": "${APP_NAME}_data"},
  {"id": "api_schema", "value": "${API_SCHEMA}"},
  {"id": "api_schemas_list", "value": "${API_SCHEMAS_LIST}"}
]
EOF
