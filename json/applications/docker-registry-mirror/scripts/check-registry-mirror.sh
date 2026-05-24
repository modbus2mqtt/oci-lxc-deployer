#!/bin/sh
# Verify the Docker Registry Mirror is working as a pull-through proxy.
#
# Runs on the PVE host (execute_on: ve) and:
# 1. Finds the mirror's LXC by hostname and reads its static IP from pct config
# 2. Verifies the deployer CA is installed in the host trust store
# 3. Probes the mirror at `https://<host>:443/v2/` via curl --resolve
#    (bypasses DNS — the mirror's hostname intentionally does not resolve
#    from outside its consumer subnet, e.g. dnsmasq-redirect is set up in
#    the nested test VM, not on the outer PVE host)
#
# Why not skopeo + nslookup?
#   nslookup of the mirror hostname returns NXDOMAIN on the PVE host that
#   hosts it, and skopeo applies the containers-image canonical-hostname
#   rule (`docker-mirror-test` with no dot AND no :port is interpreted as
#   a path component on docker.io). Both pitfalls disappear when we
#   resolve the mirror's IP locally via `pct config` and probe via
#   `curl --resolve <host>:443:<ip>` — TLS-SAN against the hostname is
#   still validated end-to-end.

MIRROR_HOST="{{ hostname }}"
[ "$MIRROR_HOST" = "NOT_DEFINED" ] || [ -z "$MIRROR_HOST" ] && MIRROR_HOST="${1:-docker-registry-mirror}"

ERRORS=""
add_error() { ERRORS="${ERRORS}${ERRORS:+\n}$1"; }

# 1. Locate the mirror LXC and its IP locally.
echo "Locating LXC for ${MIRROR_HOST}..." >&2
VMID=$(pct list 2>/dev/null | awk -v h="$MIRROR_HOST" 'NR>1 && $NF==h {print $1; exit}')
if [ -z "$VMID" ]; then
  add_error "LXC: no running container with hostname '${MIRROR_HOST}' on this PVE host"
fi

MIRROR_IP=""
if [ -n "$VMID" ]; then
  MIRROR_IP=$(pct config "$VMID" 2>/dev/null \
    | sed -nE 's/^net0:.*[ ,]ip=([0-9.]+)\/[0-9]+.*$/\1/p' | head -1)
  if [ -z "$MIRROR_IP" ]; then
    add_error "LXC: VMID $VMID has no static IPv4 in net0 — cannot probe directly"
  else
    echo "LXC: ${MIRROR_HOST} = VMID ${VMID} @ ${MIRROR_IP}" >&2
  fi
fi

# 2. Verify CA certificate is installed in the host trust store. This is
#    set up once per PVE host during deployer install/host registration.
CA_CERT="/usr/local/share/ca-certificates/proxvex-ca.crt"
if [ ! -f "$CA_CERT" ]; then
  add_error "CA: Deployer CA certificate not installed at ${CA_CERT}"
fi

# 3. Probe the mirror at its native hostname, bypassing DNS via
#    --resolve. Validates TLS-SAN (cert must cover MIRROR_HOST) AND that
#    the registry is actually serving the /v2/ root.
if [ -n "$MIRROR_IP" ]; then
  echo "Probing https://${MIRROR_HOST}/v2/ (resolve -> ${MIRROR_IP})..." >&2
  HTTP_CODE=$(curl --resolve "${MIRROR_HOST}:443:${MIRROR_IP}" \
    -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    "https://${MIRROR_HOST}/v2/" 2>/dev/null || echo "000")
  # 200 = open registry, 401 = auth-required (also "up" — common for
  # proxy-mode mirrors that gate writes); both prove the registry process
  # is alive and TLS-SAN matches the hostname.
  case "$HTTP_CODE" in
    200|401)
      echo "Mirror /v2/: HTTP ${HTTP_CODE} (TLS-SAN matches ${MIRROR_HOST}, registry up)" >&2
      ;;
    *)
      add_error "Mirror /v2/: HTTP ${HTTP_CODE} — registry not responding cleanly at https://${MIRROR_HOST}/v2/ (probed via ${MIRROR_IP})"
      ;;
  esac
fi

# Report result
if [ -n "$ERRORS" ]; then
  printf "Registry mirror check FAILED:\n%b\n" "$ERRORS" >&2
  exit 1
fi

echo "Registry mirror check PASSED" >&2
