#!/bin/sh
# Smoke check: SPA root reachable + contains Angular's <app-root>.
set -eu

APP_SUBDOMAIN="{{ app_subdomain }}"
if [ -z "$APP_SUBDOMAIN" ] || [ "$APP_SUBDOMAIN" = "NOT_DEFINED" ]; then
  echo "ERROR: app_subdomain is required" >&2; exit 1
fi

URL="https://${APP_SUBDOMAIN}/"
echo "check-spa-served: GET $URL" >&2
BODY=$(curl -fsSLk -m 10 "$URL") || {
  echo "ERROR: $URL not reachable" >&2; exit 1
}
if ! printf '%s' "$BODY" | grep -q 'app-root'; then
  echo "ERROR: $URL response does not contain <app-root>" >&2
  printf '%s' "$BODY" | head -10 >&2
  exit 1
fi
echo "check-spa-served: OK" >&2
echo '[]'
