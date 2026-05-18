# Gitea

Self-hosted Git service with web UI, code review, team collaboration, package registry, and CI/CD.

## Prerequisites

- Stacktype: `postgres`, `gitea` — shares database password with PostgreSQL, provides Gitea admin credentials
- Dependency: `postgres` must be installed in the same stack
- The database `gitea` is created automatically via the shared `create-postgres-database` template

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `gitea` | Container hostname |
| `volumes` | `data`, `config` | Git repositories and Gitea configuration |
| `volume_storage` | `local-zfs` | Proxmox storage for data volumes |

The container runs as UID 1000 (git user). Environment variables configure the PostgreSQL connection, admin user, and server settings.

### Admin User

The admin user is created via environment variable `GITEA_ADMIN_PASSWORD` from the `gitea` stack. The password is auto-generated when the stack is created.

## OIDC Authentication

Enable the `addon-oidc` addon to add Zitadel-based authentication. The addon:

1. Creates an OIDC client in Zitadel
2. Runs `gitea admin auth add-oauth` inside the container to register the OpenID Connect authentication source
3. Users can then log in via "Sign in with Zitadel" on the Gitea login page

The OIDC configuration runs as the `git` user (UID 1000) via `execute_on: { where: "lxc", uid: true, gid: true }`.

## SSL

Gitea uses `ssl_mode: native`. When SSL is enabled:

- `GITEA__server__PROTOCOL` is set to `https`
- Certificates are placed at `/etc/ssl/addon/`

## mTLS

Enable the `addon-mtls` addon (alongside `addon-ssl`) for a **passwordless,
cert-only** PostgreSQL connection:

- `addon-mtls` issues a client certificate with `CN=gitea` into
  `/etc/ssl/addon/mtls/gitea/` (`cert.pem`, `privkey.pem`, `chain.pem`).
- `conf-enable-mtls-app.sh` appends, as LXC environment (overriding the
  password-mode defaults): `GITEA__database__SSL_MODE=verify-ca`,
  `GITEA__database__USER=gitea`, and `PGSSLCERT`/`PGSSLKEY`/`PGSSLROOTCERT`
  pointing at that folder.
- The dependency PostgreSQL must run with `addon-ssl` + `pg_client_cert=true`
  so its `pg_hba.conf` authenticates the connection by the client
  certificate's CN (`gitea`).
- Without `addon-mtls`, gitea connects in the default password mode
  (`GITEA__database__USER=postgres` + `GITEA__database__PASSWD`) — non-mTLS
  scenarios are unaffected.

## Database setup

proxvex does **not** create database roles or grants (neither password nor
mTLS deployments). For an mTLS / cert-only deployment, create the connection
role once against the database, as the `postgres` superuser, before deploying
gitea:

```sql
CREATE ROLE gitea LOGIN;             -- no password: cert-only (pg_hba `cert`)
ALTER DATABASE gitea OWNER TO gitea; -- gitea runs its DDL migrations
```

The `gitea` database itself is created automatically (shared
`create-postgres-database` template). The role name must equal the client
certificate CN (`gitea`). Livetest scenarios seed this automatically via the
`livetest-local` overlay (`188-conf-init-gitea-testdb`); production is the
operator's responsibility.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 3000 | HTTP | Gitea web interface |
| 2222 | TCP | SSH for Git operations |

## Upgrade

Pulls new Gitea image. Git repositories and configuration in volumes are preserved. Gitea runs database migrations automatically on startup.

## Reconfigure

Allows enabling/disabling addons (SSL, OIDC). Volume mounts and environment variables can be changed.
