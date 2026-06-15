#!/bin/sh
# Confirm cloudflared established a tunnel connection to the Cloudflare edge.
#
# The cloudflared image is distroless (no /bin/sh, no package manager), so we
# cannot run an in-container readiness probe via lxc-attach. Instead we read
# the LXC console log on the PVE host — 107-conf-oci-lxc-configuration sets
# `lxc.console.logfile`, so cloudflared's stdout/stderr lands there.
#
# A remotely-managed (token-based) tunnel logs one line per edge connection:
#   INF Registered tunnel connection connIndex=0 ...
# We poll for that line because registration takes a few seconds after start.
#
# Template variables:
#   vm_id    - Container VM ID
#   hostname - Container hostname
#
# stdout: JSON array (schemas/outputs.schema.json). All logs go to stderr.

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"

# Prefer the container's CURRENT hostname (upgrade flows may rename it after
# create); the active console log lives at /var/log/lxc/<hostname>-<vmid>.log.
ACTUAL_HOSTNAME=$(pct config "$VM_ID" 2>/dev/null | awk '/^hostname:/ {print $2; exit}' || true)
if [ -n "$ACTUAL_HOSTNAME" ] && [ "$ACTUAL_HOSTNAME" != "$HOSTNAME" ]; then
  echo "Using actual container hostname '$ACTUAL_HOSTNAME' (template gave '$HOSTNAME')" >&2
  HOSTNAME="$ACTUAL_HOSTNAME"
fi

LOG_FILE="/var/log/lxc/${HOSTNAME}-${VM_ID}.log"
SUCCESS_PATTERN="Registered tunnel connection"

# Poll up to ~60s (12 * 5s) for the registration line.
ATTEMPTS=12
SLEEP=5
i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  if [ -f "$LOG_FILE" ] && grep -q "$SUCCESS_PATTERN" "$LOG_FILE" 2>/dev/null; then
    line=$(grep "$SUCCESS_PATTERN" "$LOG_FILE" 2>/dev/null | tail -1)
    echo "CHECK: tunnel_connected PASSED" >&2
    echo "$line" >&2
    printf '[{"id":"tunnel_connected","value":"true"}]'
    exit 0
  fi
  i=$((i + 1))
  echo "tunnel not registered yet (attempt $i/$ATTEMPTS), waiting ${SLEEP}s..." >&2
  sleep "$SLEEP"
done

echo "CHECK: tunnel_connected FAILED — '$SUCCESS_PATTERN' not found in $LOG_FILE within $((ATTEMPTS * SLEEP))s" >&2
if [ -f "$LOG_FILE" ]; then
  echo "Last 15 console log lines:" >&2
  tail -15 "$LOG_FILE" >&2
else
  echo "Console log file $LOG_FILE does not exist" >&2
fi
printf '[{"id":"tunnel_connected","value":"false"}]'
exit 1
