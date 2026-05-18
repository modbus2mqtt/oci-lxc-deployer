# PostgreSQL

PostgreSQL SQL database running as an OCI container.

## Prerequisites

- Stacktype: `postgres` — a stack is created automatically to store the database password
- No dependencies

## Installation

The default image is `postgres:16-alpine`. The container runs as UID 70 (the postgres user).

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `postgres` | Container hostname |
| `volumes` | `data`, `initdb` | Data directory and init scripts |
| `POSTGRES_PASSWORD` | (from stack) | Superuser password, auto-generated |

### Startup Order

PostgreSQL uses `startup_order: 10` to ensure it starts before dependent applications (Zitadel, Gitea, PostgREST).

## Database Creation for Dependent Apps

Applications that depend on PostgreSQL can set `database_name` in their `application.json`. The shared template `187-create-postgres-database` automatically creates the database via `execute_on: application:postgres` before the dependent app starts.

## SSL

PostgreSQL uses `ssl_mode: certs` with the `addon-ssl` addon. When SSL is enabled:

- Server certificate and key are placed at `/certs/`
- `postgresql.conf` is modified with `ssl = on`, `ssl_cert_file`, and `ssl_key_file`
  (managed `# proxvex SSL start/end` block)
- Certificate permissions are set for the postgres user (UID 70)
- The CA public certificate is always written to `/certs/chain.pem`
  (`ssl.needs_ca_cert: true`)

### Client-Certificate Authentication (mTLS)

The `pg_client_cert` parameter (default `false`, toggleable via Reconfigure)
turns on **server-side client-certificate verification**. It is only meaningful
when `addon-ssl` is active. When enabled:

- `postgresql.conf` gets a managed `# proxvex mTLS start/end` block with
  `ssl_ca_file = '/certs/chain.pem'` (depends on `ssl = on`)
- `pg_hba.conf` is replaced by the rendered `pg_hba_content` (default
  `file:pg_hba.conf.tmpl`). The stock file is backed up once to
  `pg_hba.conf.proxvex-orig` so toggling off / disabling SSL fully reverts to
  password auth — no data loss.
- Default policy is **cert-only**: `hostssl all all 0.0.0.0/0 cert`
  (CN must equal the DB user). Unix-socket connections keep
  `local all all trust`, so the container's own initdb / `POSTGRES_PASSWORD`
  bootstrap / admin maintenance keep working.
- To require a password in addition to the certificate (or use
  `clientcert=verify-ca`/`verify-full` / a mixed policy), upload a custom
  `pg_hba.conf` via the `pg_hba_content` parameter — written verbatim, no code
  change needed.
- Changes are applied via `SELECT pg_reload_conf()` (SIGHUP) — no restart.

**Cross-app implication:** with `pg_client_cert=true`, existing password-only
TCP clients (zitadel, gitea, postgrest, pgadmin) lose access until they present
a CA-signed client certificate. Clients obtain one via the `addon-mtls` addon
and connect with `sslmode=verify-ca`/`verify-full` plus
`sslcert`/`sslkey`/`sslrootcert` pointing at `/etc/mtls/<CN>/`. Migrating those
clients is out of scope of this application.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 5432 | TCP | PostgreSQL wire protocol |

## Upgrade

Pulls a new PostgreSQL image version. Data volumes are preserved. Major version upgrades may require manual `pg_upgrade`.

## Reconfigure

Allows enabling/disabling the SSL addon and toggling the `pg_client_cert`
(mTLS) parameter. Toggling `pg_client_cert` off, or disabling the SSL addon,
fully reverts to password authentication (managed config blocks removed, stock
`pg_hba.conf` restored) with no data loss.
