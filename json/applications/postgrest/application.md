# PostgREST

Automatic RESTful API from any PostgreSQL database. PostgREST introspects the database schema and generates a complete REST API with endpoints for every table, view, and function in the configured schemas — no code required.

## Prerequisites

- Stacktype: `postgres` — must share a stack with a PostgreSQL instance
- Dependency: `postgres` application must be installed in the same stack
- **Database setup is required before PostgREST can serve requests** — see [Database setup](#database-setup). proxvex does **not** create database roles, grants, schemas, or triggers.

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `postgrest` | Container hostname |
| `http_port` | `3000` | HTTP port (advanced) |
| `local_https_port` | `3443` | HTTPS port (advanced) |
| `db_schemas` | `public` | `PGRST_DB_SCHEMAS` — comma-separated schemas PostgREST exposes (not required) |
| `db_anon_role` | `web_anon` | `PGRST_DB_ANON_ROLE` — role for unauthenticated requests; **must exist in the database** |

The compose file is pre-configured with template variables for the PostgreSQL connection (`POSTGRES_HOST`, `POSTGRES_PASSWORD`), resolved automatically from the stack.

> **Breaking change:** `db_anon_role` now defaults to `web_anon` (previously the implicit `postgres` superuser). PostgREST validates the anon role at startup and will not start until `web_anon` (or your chosen `db_anon_role`) exists — see [Database setup](#database-setup).

## Database setup

These steps apply to **every** PostgREST deployment (password *and* mTLS). proxvex provisions none of this — run it once against the database, as the `postgres` superuser.

1. **Anon role** (name = `db_anon_role`, default `web_anon`; PostgREST fails to start without it):

   ```sql
   CREATE ROLE web_anon NOLOGIN;
   ```

2. **Connection role.** Password deployments connect as `${POSTGRES_USER:-postgres}`; mTLS deployments connect as `postgrest` (see [addon-mtls](#addon-mtls)). The connection role must be able to switch to the anon role:

   ```sql
   GRANT web_anon TO <connection_role>;   -- e.g. postgres, or postgrest for mTLS
   ```

3. **Table / schema grants — application-specific.** Grant the anon (and any authenticated) roles exactly the access your API should expose. Illustrative only:

   ```sql
   GRANT USAGE ON SCHEMA public TO web_anon;            -- public = db_schemas default
   GRANT SELECT ON <your_table> TO web_anon;
   ```

   The correct grants depend entirely on the schema/API you expose. Use Row-Level Security (RLS) for hardening. `db_schemas` controls which schemas PostgREST exposes (default `public`).

4. **Live schema reload (recommended).** PostgREST reloads its schema cache on `NOTIFY pgrst, 'reload schema'`; this trigger fires it on any DDL:

   ```sql
   CREATE OR REPLACE FUNCTION pgrst_watch() RETURNS event_trigger
   LANGUAGE plpgsql AS $$
   BEGIN
     NOTIFY pgrst, 'reload schema';
   END;
   $$;

   CREATE EVENT TRIGGER pgrst_watch
     ON ddl_command_end
     EXECUTE PROCEDURE pgrst_watch();
   ```

## Authentication

PostgREST has no built-in user authentication; it delegates to PostgreSQL roles and JWTs:

1. **Anonymous access** — requests without a JWT run as `db_anon_role` (default `web_anon`). Scope it via the grants in [Database setup](#database-setup).

2. **JWT authentication** — clients pass `Authorization: Bearer <token>`. PostgREST validates it with `PGRST_JWT_SECRET` and switches to the role in the token's `role` claim. Add to the compose environment:

   ```yaml
   PGRST_JWT_SECRET: "<your-secret-or-jwks-url>"
   PGRST_JWT_ROLE_CLAIM_KEY: ".role"
   ```

## SSL

PostgREST uses `ssl_mode: proxy` — the addon-ssl reverse proxy handles HTTPS termination of the **API**. This is independent of the **database** connection; for mutual TLS to PostgreSQL see [addon-mtls](#addon-mtls).

## addon-mtls

> **Warning — manual database setup required.** `addon-mtls` only wires the
> encrypted, mutually-authenticated *connection* to PostgreSQL. PostgREST will
> not serve data until you complete the general [Database setup](#database-setup)
> **and** the mTLS-specific step below. proxvex creates no database SQL.

When `addon-mtls` is enabled, a CA-signed client certificate (CN = container
hostname, default `postgrest`) is written into the `mtls/` subdir of the
`certs` volume, which PostgREST mounts at `/certs`:

```
/certs/mtls/postgrest/privkey.pem    # client private key (0600)
/certs/mtls/postgrest/cert.pem       # client certificate
/certs/mtls/postgrest/chain.pem      # root CA public certificate
```

`conf-enable-mtls-app.sh` then rewrites `PGRST_DB_URI` to connect as role
`postgrest` with `sslmode=verify-ca` and these cert paths, and binds `/certs`
into the postgrest service.

**Server side:** deploy the `postgres` dependency with `addon-ssl` +
`pg_client_cert=true` so PostgreSQL enforces `hostssl … cert`. The same
project root CA signs both sides, which is what `verify-ca` validates.

**mTLS-specific DB step** (in addition to [Database setup](#database-setup),
run as `postgres`):

```sql
CREATE ROLE postgrest LOGIN;          -- no password: hostssl … cert auth
GRANT web_anon TO postgrest;          -- the connection-role grant from step 2
-- plus the application-specific table/schema grants from step 3
```

The cert CN **must equal** the login role. If you override `POSTGRES_USER` or
`hostname`, keep `mtls_cns` and this role name aligned.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 3000 | HTTP | PostgREST API |
| 3443 | HTTPS | PostgREST API (when SSL enabled) |

## Upgrade

Pulls new PostgREST Docker image. No data to migrate — PostgREST is stateless and reads the schema from PostgreSQL at startup.

## Reconfigure

Allows enabling/disabling the SSL and mTLS addons. To change the database connection or schemas, adjust `db_schemas`/`db_anon_role` or upload a modified compose file.
