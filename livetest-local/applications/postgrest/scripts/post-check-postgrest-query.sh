#!/bin/sh
# TEST-ONLY end-to-end check for livetest postgrest scenarios.
# Runs inside the postgrest LXC (execute_on: lxc) after the docker stack is up.
#
# Issues a real HTTP request to PostgREST, which forces PostgREST to query
# PostgreSQL over its configured connection (for the mtls scenario: over
# mutual TLS as role `postgrest`). Asserts the seeded row comes back — the
# definitive proof that the full PostgREST -> PostgreSQL path works.

URL="http://127.0.0.1:3000/livetest_ping"

http_get() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$1" 2>/dev/null
  else
    wget -qO- "$1" 2>/dev/null
  fi
}

i=1
MAX=24
while [ "$i" -le "$MAX" ]; do
  BODY=$(http_get "$URL" || true)
  case "$BODY" in
    *'"pong"'*)
      echo "livetest: PostgREST end-to-end query OK (attempt $i): $BODY" >&2
      exit 0
      ;;
  esac
  echo "livetest: waiting for PostgREST query path (attempt $i/$MAX)..." >&2
  i=$((i + 1))
  sleep 5
done

echo "livetest: ERROR — PostgREST did not return the seeded row from $URL after $MAX attempts" >&2
echo "livetest: last response body: ${BODY:-<empty>}" >&2
exit 1
