# Zitadel-PostgREST SPA

Deploys an Angular SPA + per-app PostgreSQL schema + Zitadel OIDC client from a `*-proxvex.tgz` bundle packaged by [zitadel-pgrst-auth/examples/packaging/pack-for-proxvex.sh](https://github.com/) (upstream SPA repo). The application owns **no container of its own** — it provisions resources into four existing applications: `postgres`, `nginx`, `zitadel`, and `postgrest`.

## Prerequisites

- `postgres`, `nginx`, `zitadel` installed (hard `dependencies` in [application.json](application.json))
- `postgrest` installed in the same stack — declared via `with_postgrest=true` and `stacktype: postgrest`, not as a hard dependency (see [Installation order](#installation-order) for why)
- A `*-proxvex.tgz` bundle uploaded as `app_tgz_content`

## Installation order

At first glance the dependency on `postgrest` looks circular:

- The app **must run before postgrest knows about it**, because it has to create its `<slug>_api` schema in postgres so that PostgREST's `PGRST_DB_SCHEMAS` can pick it up.
- The app **must also run after postgrest is reachable**, because the SPA calls `<app_subdomain>/api`, which nginx proxies to the postgrest container.

There is no actual cycle. The flow is two-phase, with postgrest already running (with an outdated `PGRST_DB_SCHEMAS`) when the app installs, and postgrest reconfigured at the end of the app install.

### Phase A — provision resources into existing applications

Templates run in this order ([application.json](application.json) `installation`):

| Step | Template | Target | What it does |
|------|----------|--------|--------------|
| pre_start | `185-host-resolve-dependency-hosts` | host | Resolves `POSTGRES_HOST`, `POSTGREST_HOST` from stack providers |
| pre_start | `150-conf-setup-oidc-client` | zitadel API | Creates the OIDC project + client, returns `oidc_issuer_url`, `oidc_client_id` |
| pre_start | `187-create-postgres-database` | postgres LXC | Creates database `<slug>` |
| post_start | `330-provision-postgres-app` | postgres LXC | Stack-provisioning hook (auth schema, roles) |
| post_start | `220-apply-sql-migrations` | postgres LXC | Decodes the tgz, applies `bootstrap/db/*.sql` — creates the `<slug>_api` schema |
| post_start | `240-deploy-spa-to-nginx` | nginx LXC | Extracts the SPA's `dist/` into `/usr/share/nginx/html/<slug>/` |
| post_start | `260-generate-spa-config` | nginx LXC | Writes `config.json` with `postgrest.url = https://<app_subdomain>/api` and OIDC issuer/client |
| post_start | `280-write-nginx-vhost` | nginx LXC | Writes `/etc/nginx/conf.d/<slug>.conf` with `location /api/ → http://postgrest:3000/` |
| post_start | `300-seed-demo-data` | postgres LXC | Optional fixture data |
| post_start | `340-reload-nginx` | nginx LXC | `nginx -s reload` |

At this point the database schema `<slug>_api` exists in postgres, but the running postgrest still has the **old** `PGRST_DB_SCHEMAS` value (typically just `public`) and will not expose the new schema yet.

### Phase B — trigger postgrest reconfigure

| Step | Template | Target | What it does |
|------|----------|--------|--------------|
| post_start | `350-trigger-postgrest-reconfigure` | ve | `POST <deployer>/api/<ve>/ve-configuration/postgrest` with `task=reconfigure` |

The reconfigure runs postgrest's `pre_start/conf-rebuild-schemas` on the postgres LXC, which discovers all `*_api` schemas:

```sql
SELECT string_agg(nspname, ',' ORDER BY nspname)
  FROM pg_namespace
 WHERE nspname ~ '_api$' OR nspname = 'public';
```

The new value is written to the postgrest stack as `provides_pgrst_db_schemas`, the compose env is re-rendered, and postgrest restarts with `PGRST_DB_SCHEMAS=public,<slug>_api,…`.

The trigger is **best-effort**: a non-2xx response logs a warning and recommends a manual `reconfigure postgrest`, but does not fail the install. The SQL migrations and SPA deploy have already succeeded; only the schema visibility in PostgREST is delayed.

### Why the SPA does not need postgrest connection data at install time

The SPA's runtime config (`config.json`, written by `260-generate-spa-config`) only contains the logical URL `https://<app_subdomain>/api`. That hits **the app's own nginx vhost**, not postgrest directly. The vhost (`280-write-nginx-vhost`) hard-wires `proxy_pass http://postgrest:3000/` using `POSTGREST_HOST`/`POSTGREST_PORT` from the postgrest stack provider, both of which are constants for a given postgrest installation. So the SPA config is fully renderable before postgrest has been reconfigured — once Phase B completes, the proxied `/api/...` calls start returning real data.

## Reconfigure

`reconfigure` runs the subset of post_start templates that re-apply pending SQL migrations, redeploy the SPA, and re-trigger postgrest. It is idempotent — the migration bookkeeping table `<slug>_data._proxvex_migrations` skips already-applied files.

## Key parameters

| Parameter | Description |
|-----------|-------------|
| `app_slug` | Database, schema prefix (`<slug>_api`, `<slug>_data`), vhost filename, SPA html subdir |
| `app_subdomain` | nginx `server_name`, basis for `postgrest.url = https://<subdomain>/api` and the OIDC redirect URIs |
| `app_tgz_content` | base64 of the `*-proxvex.tgz` bundle (SPA `dist/`, SQL migrations, optional `app.json`) |
| `app_json_content` | Optional base64 overlay merged into the generated SPA `config.json` |
| `seed_demo_data` | If truthy, runs `300-seed-demo-data` |
| `api_login_password` | Password for the per-app `<slug>_api_login` role used by PostgREST when switching roles |
