#!/bin/sh
# Stop and destroy a temporary clone-deployer CT after a self-upgrade.
#
# Invoked by clone-cleanup-service.mts on the new (upgraded) deployer's
# boot, once the debug bundle has been pulled from the clone. The clone
# was started in parallel during the self-upgrade flow and must now be
# fully removed (rootfs + managed volumes + bind-mount inheritance).
#
# Steps:
# 1) Unlock (if any operation left a lock).
# 2) pct stop --timeout 15 (clone is a short-lived helper; long graceful
#    shutdown is not warranted — it has no application state to protect).
# 3) pct destroy --purge --destroy-unreferenced-disks 1 (removes the
#    container config and any storage volumes that were created for it).
#
# Idempotent: if the CT is already gone (e.g. retry after partial success),
# the script logs and exits 0.

set -eu

VMID="{{ clone_vmid }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  fail "clone_vmid is required"
fi

if ! pct config "$VMID" >/dev/null 2>&1; then
  log "Clone $VMID does not exist — nothing to clean up"
  printf '[{"id":"clone_destroyed","value":"already_gone"}]'
  exit 0
fi

log "Unlocking $VMID (if locked)..."
pct unlock "$VMID" >&2 2>/dev/null || true

# F.6: Capture the clone's LXC console log BEFORE destroy. It records
# init/cgroup/oom events that a clean `pct destroy` would erase along
# with the rootfs — invaluable when the clone hangs on a `pct exec` and
# the bundle alone can't explain why. Resolve the path from pct config
# (proxvex CTs write `lxc.console.logfile: /var/log/lxc/<hostname>-<vmid>.log`)
# and base64-encode it into stdout so the orchestrator can pass it
# verbatim through the JSON-only output channel.
CONSOLE_LOG=""
CONSOLE_LOG_PATH=$(pct config "$VMID" 2>/dev/null | grep -a "^lxc.console.logfile:" | awk '{print $2}' || true)
if [ -n "$CONSOLE_LOG_PATH" ] && [ -f "$CONSOLE_LOG_PATH" ]; then
  CONSOLE_LOG=$(base64 -w0 < "$CONSOLE_LOG_PATH" 2>/dev/null || base64 < "$CONSOLE_LOG_PATH" | tr -d '\n')
  log "Captured console log: $CONSOLE_LOG_PATH ($(wc -c < "$CONSOLE_LOG_PATH") bytes)"
else
  log "Console log not found (path=${CONSOLE_LOG_PATH:-unset}) — skipping capture"
fi

log "Stopping clone $VMID (graceful shutdown, timeout 15s, fall back to kill)..."
# Use `pct shutdown --timeout N --forceStop 1`: `pct stop --timeout` is not
# accepted by `pct` on this PVE (`pct stop` is the forceful path and takes
# no timeout). `--forceStop 1` makes shutdown SIGKILL after the timeout
# instead of bailing with "shutdown timed out". The bare `pct stop` is
# a last-resort fallback in case shutdown returns non-zero for an unrelated
# reason.
pct shutdown "$VMID" --timeout 15 --forceStop 1 >&2 \
  || pct stop "$VMID" >&2 \
  || log "Warning: pct shutdown/stop $VMID returned non-zero (may already be stopped)"

log "Destroying clone $VMID (purge + unreferenced disks)..."
pct destroy "$VMID" --purge --destroy-unreferenced-disks 1 >&2 \
  || fail "pct destroy $VMID failed"

log "Clone $VMID destroyed"
printf '[{"id":"clone_destroyed","value":"true"},{"id":"clone_console_log_b64","value":"%s"}]' "$CONSOLE_LOG"
