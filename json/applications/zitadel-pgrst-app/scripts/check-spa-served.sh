#!/bin/sh
# Smoke check: SPA root reachable + contains Angular's <app-root>.
set -eu

APP_SUBDOMAIN="{{ app_subdomain }}"
if [ -z "$APP_SUBDOMAIN" ] || [ "$APP_SUBDOMAIN" = "NOT_DEFINED" ]; then
  echo "ERROR: app_subdomain is required" >&2; exit 1
fi

URL="https://${APP_SUBDOMAIN}/"
echo "check-spa-served: GET $URL" >&2
BODY=$(curl -fsSLk -m 10 "$URL" 2>&1) || {
  echo "WARN: $URL not reachable from VE host — likely missing DNS for $APP_SUBDOMAIN. Set up DNS (or /etc/hosts) so the subdomain resolves to the nginx container, then re-run this check manually:" >&2
  echo "  curl -fsSLk $URL" >&2
  echo '[{"id": "spa_reachable", "value": "false"}]'
  exit 0
}
if ! printf '%s' "$BODY" | grep -q 'app-root'; then
  echo "WARN: $URL responded but content does not contain <app-root>:" >&2
  printf '%s' "$BODY" | head -5 >&2
  echo '[{"id": "spa_reachable", "value": "unexpected"}]'
  exit 0
fi
echo "check-spa-served: OK" >&2
echo '[{"id": "spa_reachable", "value": "true"}]'
