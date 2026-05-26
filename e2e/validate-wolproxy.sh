#!/bin/sh
# Smoke-test for wolproxy: verifies /health, /wake, and /status endpoints.
#
# Tests:
#   - /health responds 200
#   - /status correctly classifies the target host
#   - If target is asleep, /wake brings it up (verified via INDEPENDENT
#     ping from this host, not wolproxy /status — so wolproxy isn't
#     just confirming itself)
#
# Shutdown path is NOT tested here. wolproxy has no /shutdown endpoint;
# power-down goes via PVE REST and needs a token that doesn't exist
# until the gh-runner App-Pipeline has produced it. The snapshot-roundtrip
# workflow exercises that path separately (where the gh-runner has the
# token in its lxc.env).
#
# To exercise the cold-start path manually, shut ubuntupve down first
# (PVE web UI or `pct shutdown` from another PVE host), then run this
# script — it will detect asleep, /wake, wait until ping succeeds.
#
# Prerequisites:
#   - wolproxy container running locally (e.g. `docker run -p 5000:5000 --network host wolproxy`)
#     on a machine in the same LAN as the target host.
#   - This machine can ping the target directly.
#
# Usage:
#   WOLPROXY_URL=http://localhost:5000 \
#   UBUNTUPVE_IP=192.168.x.y \
#   UBUNTUPVE_MAC=aa:bb:cc:dd:ee:ff \
#   UBUNTUPVE_BROADCAST=192.168.x.255 \
#     ./e2e/validate-wolproxy.sh

set -e

: "${WOLPROXY_URL:=http://localhost:5000}"
: "${UBUNTUPVE_BROADCAST:=255.255.255.255}"
: "${UBUNTUPVE_IP:?must be set: target host LAN IP}"
: "${UBUNTUPVE_MAC:?must be set: target host LAN MAC}"

: "${WAKE_TIMEOUT:=180}"
: "${POLL_INTERVAL:=2}"

step() { printf "\033[1;36m[%s]\033[0m %s\n" "$1" "$2"; }
info() { printf "\033[1;33m[INFO]\033[0m %s\n" "$1"; }
fail() { printf "\033[1;31m[FAIL]\033[0m %s\n" "$1" >&2; exit 1; }

# Independent probe — does NOT go through wolproxy.
host_up() {
    ping -c 1 -W 2 "$UBUNTUPVE_IP" >/dev/null 2>&1
}

# wolproxy's own classifier — for cross-checking the /status endpoint.
wolproxy_status() {
    curl -fsS "${WOLPROXY_URL}/status?ip=${UBUNTUPVE_IP}" \
        | sed -n 's/.*"status":"\([^"]*\)".*/\1/p'
}

wait_for_ping() {
    elapsed=0
    while [ "$elapsed" -lt "$WAKE_TIMEOUT" ]; do
        if host_up; then
            step "OK" "host ${UBUNTUPVE_IP} responds to ping (after ${elapsed}s)"
            return 0
        fi
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
    done
    fail "timeout (${WAKE_TIMEOUT}s) waiting for ${UBUNTUPVE_IP} to respond to ping"
}

# --- 1. wolproxy reachable ---
step "PROBE" "wolproxy at ${WOLPROXY_URL}/health"
curl -fsS "${WOLPROXY_URL}/health" >/dev/null \
    || fail "wolproxy not reachable at ${WOLPROXY_URL}"

# --- 2. /status consistency with independent ping ---
ws=$(wolproxy_status)
if host_up; then
    expected="awake"
else
    expected="asleep"
fi
[ "$ws" = "$expected" ] \
    || fail "wolproxy /status returned '$ws' but independent ping says '$expected'"
step "STATUS" "wolproxy /status agrees with ping: $ws"

# --- 3. Wake-roundtrip (only if host is asleep) ---
if host_up; then
    info "host already awake — no /wake to exercise."
    info "to test cold-start: shut ubuntupve down (PVE web UI or 'pct shutdown')"
    info "then re-run this script."
else
    step "WAKE" "wolproxy: Magic Packet ${UBUNTUPVE_MAC} via ${UBUNTUPVE_BROADCAST}"
    curl -fsS -X POST \
        "${WOLPROXY_URL}/wake?mac=${UBUNTUPVE_MAC}&broadcast=${UBUNTUPVE_BROADCAST}" >/dev/null \
        || fail "wolproxy /wake call failed"
    wait_for_ping
fi

step "DONE" "wolproxy smoke-test passed"
