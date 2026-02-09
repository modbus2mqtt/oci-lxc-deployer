# PostgreSQL: Database and Schema Setup

## Overview

```
PostgreSQL Server
│
├── postgres (DB)        ← Admin entry point
│   └── public (Schema)  ← Admin tasks only
│
├── homeassistant (DB)   ← App database
│   ├── ha_data (Schema) ← App data
│   └── ha_api (Schema)  ← PostgREST API
│
└── zitadel (DB)         ← Created automatically
    └── (Schemas)        ← Managed by Zitadel
```

## Why This Structure?

| Level | Purpose | Isolation |
|-------|---------|-----------|
| `postgres` DB | Admin login, create new DBs | Superuser only |
| App database | Data for one application | App cannot see other DBs |
| Schema | Logical grouping | Fine-grained permissions possible |

**Important:** App users CANNOT create or see other databases. They are restricted to their own database.

---

## Quick Start: create-app-db.sh

A script is available for automatic app schema creation:

```bash
# Multiple apps with PostgREST (all in postgres DB)
./create-app-db.sh nebenkosten --postgrest
./create-app-db.sh homeassistant --postgrest

# Result:
# postgres (DB)
#   ├── nebenkosten_data, nebenkosten_api
#   └── homeassistant_data, homeassistant_api

# Optional: Use different database
./create-app-db.sh myapp --database customdb
```

The script creates (in the `postgres` DB):
- Data schema: `<app_name>_data`
- App user: `<app_name>_app`

With `--postgrest` additionally:
- API schema: `<app_name>_api`
- Shared login: `api_login` (created once)
- Anon role: `<app_name>_anon`
- User role: `<app_name>_user`

**One PostgREST instance** can serve all `*_api` schemas.

### Template Version

For automated deployments, use the shared template:

```
json/shared/templates/330-provision-postgres-app.template.json
json/shared/scripts/post-provision-postgres-app.sh
```

This template runs on `application:postgres` and can be called by other applications (e.g., homeassistant) to provision their database schemas.

---

## Minimal Setup (works but insecure)

The default setup from `postgres.docker-compose.yml`:

```yaml
POSTGRES_PASSWORD: "{{ POSTGRES_PASSWORD }}"
POSTGRES_USER: postgres      # Superuser
POSTGRES_DB: postgres        # Admin DB
```

**Fine for quick tests, but:**
- All apps use the same superuser
- No audit trail (everything runs as "postgres")
- A compromised service has full access

---

## Production Setup: Separate Database per App

### Step 1: Connect as Admin

```bash
docker exec -it postgres psql -U postgres
```

### Step 2: Create App Database and User

```sql
-- Create database
CREATE DATABASE homeassistant;

-- Create app user (NOT a superuser!)
CREATE USER ha_app WITH PASSWORD 'secure_password_here';

-- Switch to new DB
\c homeassistant

-- Schema for app data
CREATE SCHEMA ha_data;

-- Grant privileges
GRANT USAGE ON SCHEMA ha_data TO ha_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ha_data TO ha_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ha_data TO ha_app;

-- For future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA ha_data
GRANT ALL PRIVILEGES ON TABLES TO ha_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA ha_data
GRANT ALL PRIVILEGES ON SEQUENCES TO ha_app;

-- Set search path (optional but convenient)
ALTER USER ha_app SET search_path TO ha_data, public;
```

### Step 3: Connection String for the App

```
postgresql://ha_app:secure_password_here@postgres:5432/homeassistant
```

---

## PostgREST: API with Role Switching

For REST APIs, an extended setup with role switching is recommended.

### Why Role Switching?

```
HTTP Request
    │
    ▼
PostgREST (connects as ha_postgrest)
    │
    ├── No JWT → SET ROLE ha_anon (read only)
    │
    └── Valid JWT → SET ROLE ha_user (read/write)
```

**Benefits:**
- Login role has NO table privileges itself
- JWT bypass only grants anon privileges
- Audit log shows active role

### Setup

```sql
-- In the app database (e.g. homeassistant)
\c homeassistant

-- API schema
CREATE SCHEMA ha_api;

-- Login role for PostgREST (NOINHERIT = no automatic privileges)
CREATE ROLE ha_postgrest NOINHERIT LOGIN PASSWORD 'api_password';

-- Roles for API access
CREATE ROLE ha_anon NOLOGIN;   -- Unauthenticated
CREATE ROLE ha_user NOLOGIN;   -- Authenticated

-- Login role may switch to API roles
GRANT ha_anon TO ha_postgrest;
GRANT ha_user TO ha_postgrest;

-- Schema privileges
GRANT USAGE ON SCHEMA ha_api TO ha_anon, ha_user;

-- Table privileges
GRANT SELECT ON ALL TABLES IN SCHEMA ha_api TO ha_anon;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ha_api TO ha_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ha_api TO ha_user;

-- For future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA ha_api
GRANT SELECT ON TABLES TO ha_anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA ha_api
GRANT ALL PRIVILEGES ON TABLES TO ha_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA ha_api
GRANT ALL PRIVILEGES ON SEQUENCES TO ha_user;
```

### PostgREST Configuration

```yaml
environment:
  PGRST_DB_URI: "postgres://ha_postgrest:api_password@postgres:5432/homeassistant"
  PGRST_DB_SCHEMAS: ha_api
  PGRST_DB_ANON_ROLE: ha_anon
  PGRST_JWT_SECRET: "{{ JWT_SECRET }}"
```

---

## Multiple Apps on One PostgreSQL Server

```sql
-- As postgres user

-- App 1: Home Assistant
CREATE DATABASE homeassistant;
CREATE USER ha_app WITH PASSWORD 'pw1';
GRANT CONNECT ON DATABASE homeassistant TO ha_app;

-- App 2: Grafana
CREATE DATABASE grafana;
CREATE USER grafana_app WITH PASSWORD 'pw2';
GRANT CONNECT ON DATABASE grafana TO grafana_app;

-- App 3: n8n
CREATE DATABASE n8n;
CREATE USER n8n_app WITH PASSWORD 'pw3';
GRANT CONNECT ON DATABASE n8n TO n8n_app;
```

**Each user can ONLY see and use their own database.**

---

## Security Checklist

| Aspect | Minimal | Production |
|--------|---------|------------|
| Superuser for apps | ✓ postgres | ✗ Separate users |
| Separate databases | ✗ All in postgres | ✓ Per app |
| Schemas | ✗ public | ✓ App-specific |
| Passwords | Example values | Randomly generated |
| PostgREST | As postgres | Role switching |

---

## Useful Commands

```sql
-- Show all databases
\l

-- Show all users/roles
\du

-- Show all schemas in current DB
\dn

-- Check user privileges
\dp schema_name.*

-- Switch to another DB
\c database_name

-- Show current user
SELECT current_user, current_database();
```
