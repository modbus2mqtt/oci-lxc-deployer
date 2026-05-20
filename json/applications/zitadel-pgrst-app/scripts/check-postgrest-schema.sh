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
BODY=$(curl -fsSLk -m 10 "$URL") || {
  echo "ERROR: $URL not reachable" >&2; exit 1
}
# Look for any reference to <slug>_api (either as 'definitions' key or 'tags').
if ! printf '%s' "$BODY" | grep -q "${APP_SLUG}_api"; then
  echo "ERROR: $URL response does not mention ${APP_SLUG}_api" >&2
  printf '%s' "$BODY" | head -5 >&2
  exit 1
fi
echo "check-postgrest-schema: OK — ${APP_SLUG}_api mentioned in OpenAPI doc" >&2
echo '[]'
