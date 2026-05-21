#!/bin/sh
# Provision the generic Zitadel<->Postgres identity / RLS core into an app DB.
#
# Installs the `auth` schema (organizations/users/user_roles, JIT
# ensure_principal, STABLE accessors, whoami) — the reusable contract from the
# zitadel-pgrst-auth base. Knows ONLY Zitadel org+user; roles are assigned in
# auth.user_roles by the app (role-name-agnostic). PostgREST verifies the
# Zitadel JWT via JWKS/RS256 and runs `auth.ensure_principal` as
# PGRST_DB_PRE_REQUEST. No Zitadel action, no nginx-Lua, no HMAC.
#
# Runs in the postgres container (execute_on: application:postgres) as the
# postgres superuser, AFTER 330-provision-postgres-app (roles/schemas exist).
#
# Requires:
#   - app_name:     application name (required) -> grants to <app>_anon/_user
#   - database:     target database (default: postgres)
#   - db_anon_role: PostgREST anon role (default: web_anon) — also granted
#
# Output: JSON to stdout (logs to stderr). POSIX sh, no `2>&1` (proxvex rule).

APP_NAME="{{ app_name }}"
DATABASE="{{ database }}"
DB_ANON_ROLE="{{ db_anon_role }}"

DATABASE="${DATABASE:-postgres}"
DB_ANON_ROLE="${DB_ANON_ROLE:-web_anon}"

if [ -z "$APP_NAME" ] || [ "$APP_NAME" = "NOT_DEFINED" ]; then
  echo "Error: app_name is required" >&2
  exit 1
fi

echo "Provisioning auth/RLS core into database: $DATABASE" >&2

psql -v ON_ERROR_STOP=1 -U postgres -d "$DATABASE" >&2 <<'SQL'
-- ===== generic core (verbatim from zitadel-pgrst-auth/auth/01_auth_schema.sql,
--       grants parameterised below) — idempotent, ON_ERROR_STOP-safe =========
CREATE SCHEMA IF NOT EXISTS auth;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS auth.organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zitadel_org_id  text UNIQUE NOT NULL,
  name            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zitadel_sub   text UNIQUE NOT NULL,
  org_id        uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE RESTRICT,
  email         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_users_org ON auth.users(org_id);
CREATE TABLE IF NOT EXISTS auth.user_roles (
  user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role     text NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE OR REPLACE FUNCTION auth._claims() RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$fn$;

CREATE OR REPLACE FUNCTION auth.sub() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT auth._claims() ->> 'sub'
$fn$;

CREATE OR REPLACE FUNCTION auth._zitadel_org_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT COALESCE(
    auth._claims() ->> 'urn:zitadel:iam:user:resourceowner:id',
    auth._claims() ->> 'urn:zitadel:iam:org:id',
    auth._claims() ->> 'org_id')
$fn$;

CREATE OR REPLACE FUNCTION auth.ensure_principal() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = auth, pg_temp AS $fn$
DECLARE
  v_sub text := auth.sub();
  v_oid text := auth._zitadel_org_id();
  v_org uuid;
BEGIN
  IF v_sub IS NULL OR v_oid IS NULL THEN RETURN; END IF;
  IF current_setting('transaction_read_only') = 'on' THEN RETURN; END IF;
  INSERT INTO auth.organizations (zitadel_org_id) VALUES (v_oid)
    ON CONFLICT (zitadel_org_id) DO NOTHING;
  SELECT id INTO v_org FROM auth.organizations WHERE zitadel_org_id = v_oid;
  INSERT INTO auth.users (zitadel_sub, org_id, email)
  VALUES (v_sub, v_org, auth._claims() ->> 'email')
  ON CONFLICT (zitadel_sub) DO UPDATE
    SET email = COALESCE(EXCLUDED.email, auth.users.email);
END;
$fn$;

CREATE OR REPLACE FUNCTION auth.user_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth, pg_temp AS $fn$
  SELECT id FROM auth.users WHERE zitadel_sub = auth.sub()
$fn$;
CREATE OR REPLACE FUNCTION auth.org_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth, pg_temp AS $fn$
  SELECT org_id FROM auth.users WHERE zitadel_sub = auth.sub()
$fn$;
CREATE OR REPLACE FUNCTION auth.roles() RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth, pg_temp AS $fn$
  SELECT COALESCE(array_agg(r.role), '{}')
  FROM auth.user_roles r
  WHERE r.user_id = (SELECT id FROM auth.users WHERE zitadel_sub = auth.sub())
$fn$;
CREATE OR REPLACE FUNCTION auth.has_role(p_role text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM auth.user_roles r
    WHERE r.user_id = (SELECT id FROM auth.users WHERE zitadel_sub = auth.sub())
      AND r.role = p_role)
$fn$;

CREATE OR REPLACE FUNCTION public.whoami() RETURNS jsonb
  LANGUAGE sql STABLE AS $fn$
  SELECT jsonb_build_object('user_id', auth.user_id(),
                            'org_id',  auth.org_id(),
                            'roles',   to_jsonb(auth.roles()))
$fn$;
CREATE OR REPLACE FUNCTION public.ensure_principal() RETURNS jsonb
  LANGUAGE sql VOLATILE AS $fn$
  SELECT auth.ensure_principal();
  SELECT public.whoami();
$fn$;
SQL

# Grants to the app's PostgREST roles (auth.* reachable ONLY via functions).
for ROLE in "$DB_ANON_ROLE" "${APP_NAME}_anon" "${APP_NAME}_user"; do
  psql -v ON_ERROR_STOP=1 -U postgres -d "$DATABASE" >&2 <<SQL
DO \$do\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
    GRANT USAGE ON SCHEMA auth TO ${ROLE};
    GRANT EXECUTE ON FUNCTION
      auth._claims(), auth.sub(), auth._zitadel_org_id(),
      auth.ensure_principal(), auth.user_id(), auth.org_id(),
      auth.roles(), auth.has_role(text),
      public.whoami(), public.ensure_principal()
    TO ${ROLE};
  END IF;
END
\$do\$;
SQL
done

echo "Auth/RLS core provisioned." >&2

cat <<EOF
[
  {"id": "auth_schema", "value": "auth"}
]
EOF
