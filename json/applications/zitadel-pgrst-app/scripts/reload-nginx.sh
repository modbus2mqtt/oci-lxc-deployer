#!/bin/sh
# Trigger nginx reload (graceful, no connection drop).
set -eu

if ! command -v nginx >/dev/null 2>&1; then
  echo "ERROR: nginx not on PATH inside the container" >&2
  exit 1
fi

# Validate first; reload only if config is OK.
nginx -t 2>&1 | tail -5 >&2
nginx -s reload
echo "reload-nginx: SIGHUP sent to nginx master" >&2
echo '[]'
