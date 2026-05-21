#!/bin/sh
# Trigger a postgrest reconfigure via the deployer API. PostgREST's reconfigure
# pre_start runs `conf-rebuild-schemas` which auto-discovers all *_api schemas
# in postgres and updates PGRST_DB_SCHEMAS. After this trigger completes,
# postgrest's compose env reflects this app's newly created <slug>_api schema.
#
# Best-effort: a non-2xx response logs a warning and recommends manual
# `reconfigure postgrest` but does not fail the consumer install/upgrade —
# the SQL migrations and SPA deploy have already succeeded.
set -eu

DEPLOYER_URL="{{ deployer_base_url }}"
VE_CONTEXT="{{ ve_context_key }}"
APP_SLUG="{{ app_slug }}"

case "$DEPLOYER_URL" in ""|NOT_DEFINED)
  echo "WARN: deployer_base_url not set — skipping postgrest reconfigure trigger." >&2
  echo "      Run \`reconfigure postgrest\` manually so PGRST_DB_SCHEMAS picks up ${APP_SLUG}_api." >&2
  echo '[{"id":"postgrest_reconfigure_triggered","value":"skipped"}]'
  exit 0
  ;;
esac
case "$VE_CONTEXT" in ""|NOT_DEFINED)
  echo "WARN: ve_context_key not set — skipping postgrest reconfigure trigger." >&2
  echo '[{"id":"postgrest_reconfigure_triggered","value":"skipped"}]'
  exit 0
  ;;
esac

URL="${DEPLOYER_URL}/api/${VE_CONTEXT}/ve-configuration/postgrest"
echo "trigger-postgrest-reconfigure: POST $URL (task=reconfigure)" >&2

RESP=$(curl -sk -m 30 -o /tmp/zpa-trigger-resp.$$ -w '%{http_code}' \
  -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -d '{"task":"reconfigure","changedParams":[]}' 2>&1) || RESP="curl_failed"

case "$RESP" in
  20*)
    echo "trigger-postgrest-reconfigure: OK (HTTP $RESP) — postgrest reconfigure queued." >&2
    cat /tmp/zpa-trigger-resp.$$ >&2 || true
    rm -f /tmp/zpa-trigger-resp.$$
    echo '[{"id":"postgrest_reconfigure_triggered","value":"true"}]'
    ;;
  *)
    echo "WARN: postgrest reconfigure trigger returned HTTP $RESP. Response body:" >&2
    cat /tmp/zpa-trigger-resp.$$ >&2 || true
    rm -f /tmp/zpa-trigger-resp.$$
    echo "      ${APP_SLUG}_api will not be exposed by PostgREST until a manual" >&2
    echo "      \`reconfigure postgrest\` is run." >&2
    echo '[{"id":"postgrest_reconfigure_triggered","value":"failed"}]'
    ;;
esac
