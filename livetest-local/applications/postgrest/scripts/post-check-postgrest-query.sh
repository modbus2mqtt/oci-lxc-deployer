#!/bin/bash
# TEST-ONLY end-to-end check for livetest postgrest scenarios.
# Runs inside the postgrest LXC (execute_on: lxc) after the docker stack is up.
#
# Issues a real HTTP request to PostgREST, which forces PostgREST to query
# PostgreSQL over its configured connection (for the mtls scenario: over
# mutual TLS as the cert-CN role). Asserts the seeded row comes back — the
# definitive proof that the full PostgREST -> PostgreSQL path works.
#
# The debian-docker LXC ships no curl/wget/python3, but has bash, so use a
# pure-bash /dev/tcp HTTP/1.1 GET (zero extra dependencies).

HOST=127.0.0.1
PORT=3000
PATH_REQ=/livetest_ping

http_get() {
  exec 3<>"/dev/tcp/${HOST}/${PORT}" 2>/dev/null || return 1
  printf 'GET %s HTTP/1.1\r\nHost: %s\r\nAccept: application/json\r\nConnection: close\r\n\r\n' \
    "$PATH_REQ" "$HOST" >&3
  cat <&3
  exec 3>&- 3<&- 2>/dev/null || true
}

i=1
MAX=24
BODY=""
while [ "$i" -le "$MAX" ]; do
  BODY=$(timeout 8 bash -c "$(declare -f http_get); HOST=$HOST PORT=$PORT PATH_REQ=$PATH_REQ http_get" 2>/dev/null || true)
  case "$BODY" in
    *'"pong"'*)
      echo "livetest: PostgREST end-to-end query OK (attempt $i)" >&2
      echo "livetest: response: $(printf '%s' "$BODY" | tr -d '\r' | tail -1)" >&2
      exit 0
      ;;
  esac
  echo "livetest: waiting for PostgREST query path (attempt $i/$MAX)..." >&2
  i=$((i + 1))
  sleep 5
done

echo "livetest: ERROR — PostgREST did not return the seeded row from http://${HOST}:${PORT}${PATH_REQ} after $MAX attempts" >&2
echo "livetest: last response: $(printf '%s' "${BODY:-<empty>}" | tr -d '\r' | tail -3)" >&2
exit 1
