#!/bin/sh
# Rebuild PGRST_DB_SCHEMAS by discovering all *_api schemas in postgres plus
# the public schema. Runs in the postgres LXC at every postgrest installation
# and reconfigure, so postgrest's compose env (PGRST_DB_SCHEMAS) reflects
# every consumer's schema (e.g. zitadel-pgrst-app adds products_api etc.).
#
# Outputs:
#   db_schemas                    — substituted into postgrest's compose env
#   provides_pgrst_db_schemas     — published to the postgrest stack for consumers
#   provides_postgrest_host       — postgrest container hostname (constant per install)
#   provides_postgrest_port       — postgrest listen port (3000)
#   provides_postgrest_url        — http://<host>:<port>
set -eu

HOSTNAME="{{ hostname }}"
case "$HOSTNAME" in ""|NOT_DEFINED) HOSTNAME="postgrest" ;; esac

SCHEMAS=$(psql -U postgres -d postgres -tAc "SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace WHERE nspname ~ '_api\$' OR nspname = 'public'" 2>/dev/null || true)
[ -n "$SCHEMAS" ] || SCHEMAS=public

echo "conf-rebuild-schemas: discovered PGRST_DB_SCHEMAS=$SCHEMAS, host=$HOSTNAME:3000" >&2

cat <<JSON
[
  {"id":"db_schemas","value":"$SCHEMAS"},
  {"id":"provides_pgrst_db_schemas","value":"$SCHEMAS"},
  {"id":"provides_postgrest_host","value":"$HOSTNAME"},
  {"id":"provides_postgrest_port","value":"3000"},
  {"id":"provides_postgrest_url","value":"http://$HOSTNAME:3000"}
]
JSON
