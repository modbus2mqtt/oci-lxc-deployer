#!/bin/sh
# Assert PostgREST exposes the app's <slug>_api schema.
#
# Runs on the VE host. Resolves the postgrest VMID via the dependency
# resolver's POSTGREST_HOST output, reads the live container's
# PGRST_DB_SCHEMAS env, and fails if it does not contain <slug>_api.
#
# Template variables:
#   app_slug        - <slug>_api is the expected schema
#   POSTGREST_HOST  - resolved by 185-host-resolve-dependency-hosts

set -eu

APP_SLUG="{{ app_slug }}"
POSTGREST_HOST="{{ POSTGREST_HOST }}"

if [ -z "$APP_SLUG" ] || [ "$APP_SLUG" = "NOT_DEFINED" ]; then
  echo "ERROR: app_slug is required" >&2; exit 1
fi
case "$POSTGREST_HOST" in ""|NOT_DEFINED) POSTGREST_HOST="postgrest" ;; esac

EXPECTED="${APP_SLUG}_api"

# Resolve VMID. ve-global.sh provides find_vmid_by_hostname.
PG_VMID=$(find_vmid_by_hostname "$POSTGREST_HOST" 2>/dev/null) || PG_VMID=""
if [ -z "$PG_VMID" ]; then
  echo "ERROR: could not resolve postgrest container (host=$POSTGREST_HOST)" >&2
  exit 1
fi

# Read PGRST_DB_SCHEMAS as the docker container sees it.
SCHEMAS=$(pct exec "$PG_VMID" -- sh -c 'docker exec $(docker ps -q -f name=postgrest) printenv PGRST_DB_SCHEMAS 2>/dev/null' 2>/dev/null || true)

echo "assert-postgrest-schema: postgrest PGRST_DB_SCHEMAS='$SCHEMAS' (expecting to find '$EXPECTED')" >&2

if [ -z "$SCHEMAS" ]; then
  echo "ERROR: could not read PGRST_DB_SCHEMAS from postgrest container" >&2
  exit 1
fi

# Check if EXPECTED is in the comma-separated list (with surrounding whitespace ok).
if echo ",$SCHEMAS," | tr -d ' ' | grep -q ",${EXPECTED},"; then
  echo "assert-postgrest-schema: OK — '$EXPECTED' is exposed" >&2
  echo '[]'
  exit 0
fi

cat >&2 <<EOF
ERROR: PostgREST does not expose '$EXPECTED'.

  Current PGRST_DB_SCHEMAS: $SCHEMAS

  Iteration 1 of zitadel-pgrst-app requires the operator to extend the
  postgrest application's 'db_schemas' parameter to include all app API
  schemas before installing each new SPA, e.g.:

    db_schemas = public,${EXPECTED}

  Then run: reconfigure postgrest

  Iteration 2 will automate this (see plan, Open Question 2).
EOF
exit 1
