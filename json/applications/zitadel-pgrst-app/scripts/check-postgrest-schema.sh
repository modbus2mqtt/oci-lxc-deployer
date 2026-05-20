#!/bin/sh
# Smoke check: PostgREST reachable through nginx /api/ and the OpenAPI doc
# mentions the <slug>_api namespace.
set -eu

APP_SLUG="{{ app_slug }}"
APP_SUBDOMAIN="{{ app_subdomain }}"
if [ -z "$APP_SUBDOMAIN" ] || [ "$APP_SUBDOMAIN" = "NOT_DEFINED" ]; then
  echo "ERROR: app_subdomain is required" >&2; exit 1
fi
if [ -z "$APP_SLUG" ] || [ "$APP_SLUG" = "NOT_DEFINED" ]; then
  echo "ERROR: app_slug is required" >&2; exit 1
fi

URL="https://${APP_SUBDOMAIN}/api/"
echo "check-postgrest-schema: GET $URL" >&2
BODY=$(curl -fsSLk -m 10 "$URL" 2>&1) || {
  echo "WARN: $URL not reachable from VE host — likely DNS or postgrest db_schemas missing ${APP_SLUG}_api. Re-run manually after DNS + postgrest reconfigure." >&2
  echo '[{"id": "postgrest_reachable", "value": "false"}]'
  exit 0
}
if ! printf '%s' "$BODY" | grep -q "${APP_SLUG}_api"; then
  echo "WARN: $URL responded but does not mention ${APP_SLUG}_api yet (postgrest db_schemas needs to include it)." >&2
  printf '%s' "$BODY" | head -3 >&2
  echo '[{"id": "postgrest_reachable", "value": "unexpected"}]'
  exit 0
fi
echo "check-postgrest-schema: OK — ${APP_SLUG}_api mentioned in OpenAPI doc" >&2
echo '[{"id": "postgrest_reachable", "value": "true"}]'
