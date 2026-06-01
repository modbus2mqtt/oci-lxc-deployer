#!/bin/sh
# TEST-ONLY end-to-end check for the `extra_envs` overlay feature.
# Runs inside the gitea LXC (execute_on: lxc) after the container is up.
#
# Proves the full chain works:
#   scenario `extra_envs` (GITEA__server__ROOT_URL=...) → merged over `envs`
#   by conf-oci-lxc-configuration.py → lxc.environment → the image's
#   environment-to-ini → /data/gitea/conf/app.ini.
#
# The check is dynamic: it extracts the ROOT_URL requested via extra_envs and
# asserts that exact value landed in app.ini. If the scenario did NOT request a
# custom ROOT_URL, it skips (passes) — so non-default scenarios are unaffected.

EXTRA_ENVS="{{ extra_envs }}"
APP_INI=/data/gitea/conf/app.ini

# Pull the requested ROOT_URL out of the (newline-separated) extra_envs block.
EXPECT=$(printf '%s\n' "$EXTRA_ENVS" | sed -n 's/^GITEA__server__ROOT_URL=//p' | head -n1)

if [ -z "$EXPECT" ] || [ "$EXTRA_ENVS" = "NOT_DEFINED" ]; then
  echo "livetest: no custom GITEA__server__ROOT_URL in extra_envs — skipping app.ini assertion" >&2
  exit 0
fi

echo "livetest: expecting app.ini ROOT_URL to start with: ${EXPECT}" >&2

i=1
MAX=12
while [ "$i" -le "$MAX" ]; do
  if [ -f "$APP_INI" ]; then
    ACTUAL=$(sed -n 's/^ROOT_URL[[:space:]]*=[[:space:]]*//p' "$APP_INI" | head -n1)
    # gitea normalizes ROOT_URL (may append a trailing slash) — accept both.
    case "$ACTUAL" in
      "$EXPECT"|"$EXPECT"/)
        echo "livetest: app.ini ROOT_URL matches extra_envs override (attempt $i): ROOT_URL = ${ACTUAL}" >&2
        exit 0
        ;;
    esac
  fi
  echo "livetest: waiting for app.ini ROOT_URL=${EXPECT} (attempt $i/$MAX)..." >&2
  i=$((i + 1))
  sleep 5
done

echo "livetest: ERROR — app.ini did not contain ROOT_URL=${EXPECT} after $MAX attempts" >&2
if [ -f "$APP_INI" ]; then
  echo "livetest: actual [server] ROOT_URL line:" >&2
  grep -E "^ROOT_URL" "$APP_INI" >&2 || echo "livetest: (no ROOT_URL line in $APP_INI)" >&2
else
  echo "livetest: app.ini not found at $APP_INI" >&2
fi
exit 1
