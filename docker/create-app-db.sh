#!/bin/bash
# =============================================================================
# Create Application Schema with optional PostgREST roles
# =============================================================================
# Usage: ./create-app-db.sh <app_name> [--postgrest] [--database <db>]
#
# Examples:
#   ./create-app-db.sh nebenkosten --postgrest
#   ./create-app-db.sh homeassistant --postgrest
#   ./create-app-db.sh myapp --database customdb
# =============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Defaults
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
CONTAINER_NAME="${CONTAINER_NAME:-postgres}"
USE_DOCKER="${USE_DOCKER:-true}"
DATABASE="postgres"  # Default: use postgres database

# Parse arguments
APP_NAME=""
POSTGREST=false
APP_PASSWORD=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --postgrest)
            POSTGREST=true
            shift
            ;;
        --password)
            APP_PASSWORD="$2"
            shift 2
            ;;
        --database)
            DATABASE="$2"
            shift 2
            ;;
        --no-docker)
            USE_DOCKER=false
            shift
            ;;
        --help|-h)
            echo "Usage: $0 <app_name> [--postgrest] [--database <db>] [--password <pwd>]"
            echo ""
            echo "Creates schemas for an app in a shared database (default: postgres)"
            echo ""
            echo "Options:"
            echo "  --postgrest       Create PostgREST roles (api_login, anon, user)"
            echo "  --database <db>   Target database (default: postgres)"
            echo "  --password <pwd>  Set app user password (default: auto-generated)"
            echo "  --no-docker       Connect directly to PostgreSQL (not via docker)"
            echo ""
            echo "Environment variables:"
            echo "  POSTGRES_HOST      PostgreSQL host (default: localhost)"
            echo "  POSTGRES_PORT      PostgreSQL port (default: 5432)"
            echo "  POSTGRES_USER      Admin user (default: postgres)"
            echo "  PGPASSWORD         Admin password"
            echo "  CONTAINER_NAME     Docker container name (default: postgres)"
            exit 0
            ;;
        -*)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
        *)
            APP_NAME="$1"
            shift
            ;;
    esac
done

# Validate
if [ -z "$APP_NAME" ]; then
    echo -e "${RED}Error: App name required${NC}"
    echo "Usage: $0 <app_name> [--postgrest] [--database <db>]"
    exit 1
fi

# Generate password if not provided
if [ -z "$APP_PASSWORD" ]; then
    APP_PASSWORD=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)
fi

# Function to run SQL
run_sql() {
    if [ "$USE_DOCKER" = true ]; then
        docker exec -i "$CONTAINER_NAME" psql -U "$POSTGRES_USER" "$@"
    else
        PGPASSWORD="${PGPASSWORD}" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" "$@"
    fi
}

echo -e "${GREEN}Creating schemas for: ${APP_NAME} in database: ${DATABASE}${NC}"
echo "========================================"

# Create database if it doesn't exist (only if not postgres)
if [ "$DATABASE" != "postgres" ]; then
    DB_EXISTS=$(run_sql -tAc "SELECT 1 FROM pg_database WHERE datname='${DATABASE}'" 2>/dev/null || echo "")
    if [ "$DB_EXISTS" != "1" ]; then
        echo "Creating database ${DATABASE}..."
        run_sql -c "CREATE DATABASE ${DATABASE};"
    fi
fi

# Create app user and schemas
run_sql -d "$DATABASE" <<EOF
-- Create app user (if not exists)
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_NAME}_app') THEN
        CREATE USER ${APP_NAME}_app WITH PASSWORD '${APP_PASSWORD}';
    END IF;
END
\$\$;

-- Create data schema
CREATE SCHEMA IF NOT EXISTS ${APP_NAME}_data;

-- Grant privileges
GRANT CONNECT ON DATABASE ${DATABASE} TO ${APP_NAME}_app;
GRANT USAGE ON SCHEMA ${APP_NAME}_data TO ${APP_NAME}_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${APP_NAME}_data TO ${APP_NAME}_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${APP_NAME}_data TO ${APP_NAME}_app;

-- Default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_NAME}_data
GRANT ALL PRIVILEGES ON TABLES TO ${APP_NAME}_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_NAME}_data
GRANT ALL PRIVILEGES ON SEQUENCES TO ${APP_NAME}_app;

-- Set search path
ALTER USER ${APP_NAME}_app SET search_path TO ${APP_NAME}_data, public;
EOF

echo -e "${GREEN}Schemas created successfully!${NC}"
echo ""

# PostgREST setup
if [ "$POSTGREST" = true ]; then
    echo -e "${YELLOW}Creating PostgREST roles...${NC}"

    # Check if shared api_login role exists
    API_LOGIN_EXISTS=$(run_sql -tAc "SELECT 1 FROM pg_roles WHERE rolname='api_login'" 2>/dev/null || echo "")

    if [ "$API_LOGIN_EXISTS" != "1" ]; then
        echo -e "${YELLOW}Creating shared api_login role...${NC}"
        API_LOGIN_PASSWORD=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)
        run_sql <<EOF
-- Shared login role for PostgREST (NOINHERIT = no automatic privileges)
CREATE ROLE api_login NOINHERIT LOGIN PASSWORD '${API_LOGIN_PASSWORD}';

-- Shared anonymous role (fallback when no JWT)
CREATE ROLE api_anon NOLOGIN;
GRANT api_anon TO api_login;
EOF
        echo -e "${GREEN}Created api_login with password: ${API_LOGIN_PASSWORD}${NC}"
        echo -e "${RED}Save this password! It's needed for PGRST_DB_URI${NC}"
        echo ""
    else
        echo "api_login role already exists"
    fi

    # Create app-specific roles
    run_sql -d "$DATABASE" <<EOF
-- API Schema
CREATE SCHEMA IF NOT EXISTS ${APP_NAME}_api;

-- App-specific API roles (if not exist)
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_NAME}_anon') THEN
        CREATE ROLE ${APP_NAME}_anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_NAME}_user') THEN
        CREATE ROLE ${APP_NAME}_user NOLOGIN;
    END IF;
END
\$\$;

-- api_login can switch to these roles
GRANT ${APP_NAME}_anon TO api_login;
GRANT ${APP_NAME}_user TO api_login;

-- Grant connect
GRANT CONNECT ON DATABASE ${DATABASE} TO api_login;

-- Schema privileges
GRANT USAGE ON SCHEMA ${APP_NAME}_api TO ${APP_NAME}_anon, ${APP_NAME}_user;

-- Table privileges (anon = read only, user = full access)
GRANT SELECT ON ALL TABLES IN SCHEMA ${APP_NAME}_api TO ${APP_NAME}_anon;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${APP_NAME}_api TO ${APP_NAME}_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${APP_NAME}_api TO ${APP_NAME}_user;

-- Default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_NAME}_api
GRANT SELECT ON TABLES TO ${APP_NAME}_anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_NAME}_api
GRANT ALL PRIVILEGES ON TABLES TO ${APP_NAME}_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_NAME}_api
GRANT ALL PRIVILEGES ON SEQUENCES TO ${APP_NAME}_user;
EOF

    echo -e "${GREEN}PostgREST roles created!${NC}"
fi

# Get all API schemas in this database
ALL_SCHEMAS=$(run_sql -d "$DATABASE" -tAc "SELECT string_agg(nspname, ',') FROM pg_namespace WHERE nspname LIKE '%_api'" 2>/dev/null || echo "${APP_NAME}_api")

# Output summary
echo ""
echo "========================================"
echo -e "${GREEN}Setup Complete!${NC}"
echo "========================================"
echo ""
echo "Database:     ${DATABASE}"
echo "Data Schema:  ${APP_NAME}_data"
echo ""
echo -e "${YELLOW}App User:${NC}"
echo "  User:       ${APP_NAME}_app"
echo "  Password:   ${APP_PASSWORD}"
echo "  Connection: postgresql://${APP_NAME}_app:${APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${DATABASE}"
echo ""

if [ "$POSTGREST" = true ]; then
    echo -e "${YELLOW}PostgREST Roles:${NC}"
    echo "  API Schema: ${APP_NAME}_api"
    echo "  Anon Role:  ${APP_NAME}_anon  (read-only)"
    echo "  User Role:  ${APP_NAME}_user  (full access)"
    echo ""
    echo -e "${YELLOW}JWT Claims:${NC}"
    echo "  { \"role\": \"${APP_NAME}_user\" }"
    echo ""
    echo -e "${YELLOW}PostgREST Config:${NC}"
    echo "  PGRST_DB_URI:       postgres://api_login:<password>@${POSTGRES_HOST}:${POSTGRES_PORT}/${DATABASE}"
    echo "  PGRST_DB_SCHEMAS:   ${ALL_SCHEMAS}"
    echo "  PGRST_DB_ANON_ROLE: api_anon"
    echo ""
fi

echo -e "${YELLOW}Save these passwords - they cannot be retrieved later!${NC}"
