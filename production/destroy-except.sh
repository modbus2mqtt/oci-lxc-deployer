#!/bin/bash
# >>> proxvex-cwd-guard (auto-generated) — repo-root cwd + absolute $0, any caller cwd
case "$0" in
  /*) _pvx_self="$0" ;;
  *)  _pvx_self="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")" || { echo "FATAL cwd-guard: cannot resolve $0" >&2; exit 2; } ;;
esac
_pvx_rr="$(cd "$(dirname "$_pvx_self")/.." 2>/dev/null && pwd)" || { echo "FATAL cwd-guard: cannot resolve repo root from $0" >&2; exit 2; }
{ [ -f "$_pvx_rr/package.json" ] && [ -d "$_pvx_rr/e2e" ] && [ -d "$_pvx_rr/production" ]; } || { echo "FATAL cwd-guard: invalid repo root '$_pvx_rr' (from '$0')" >&2; exit 2; }
if [ "$0" != "$_pvx_self" ]; then cd "$_pvx_rr" && exec "$_pvx_self" "$@"; fi
cd "$_pvx_rr" || { echo "FATAL cwd-guard: cannot cd to '$_pvx_rr'" >&2; exit 2; }
unset _pvx_self _pvx_rr
# <<< proxvex-cwd-guard
# Destroy all LXC containers on this PVE host except the three production
# survivors. Runs directly on the PVE host (no SSH).
#
# Keep-list (hardcoded): proxvex, docker-registry-mirror, nginx.
# These three preserve the deployer state, the cached registry images and
# the nginx vhost / acme.sh CA so a fresh production rebuild does not have
# to redo TLS issuance.
#
# Pre-flight: aborts if any of the three is missing — the goal is to keep
# them, so their absence means something is already off and the operator
# should investigate before wiping anything else.
#
# Three phases:
#   1. Locked containers (lock entry in pct config) — pct unlock + force
#      destroy first, since a stuck lock blocks normal stop/destroy.
#   2. Everything else — pct stop + pct destroy --purge --force.
#   3. Neutralize OIDC on the kept deployer: this script always keeps
#      `proxvex` but never `zitadel`, so a deployer that had OIDC enabled
#      (setup-production.sh Step 11) now points at an IdP that no longer
#      exists — every pre-Step-11 deployer API call would 401 and the
#      rebuild could not bootstrap. We strip the OIDC_* lxc.environment
#      lines from the deployer's LXC config and restart it so it comes
#      back with auth disabled. Step 11 re-adds them. Idempotent.
#
# Usage (on pve1.cluster):
#   ./production/destroy-except.sh           # ask for confirmation, then run
#   ./production/destroy-except.sh -y        # skip confirmation
#
# Full rebuild recipe (zitadel DB reset, managed-volume reshape, ...):
#   1. ./production/destroy-except.sh        # on pve1; Phase 3 strips the
#                                            #   kept deployer's OIDC env so
#                                            #   the API is reachable unauth'd
#   2. ./production/deploy.sh --host pve1.cluster \
#        production/proxvex-upgrade.json     # upgrade TASK → new container
#                                            #   from latest OCI; the oci-image
#                                            #   upgrade carries the managed
#                                            #   /config + /secure volumes
#                                            #   (oidc/cloudflare stacks, nginx
#                                            #   certs) over to it. Do NOT use
#                                            #   `curl install-proxvex.sh|sh`:
#                                            #   that creates a fresh container
#                                            #   WITHOUT the volumes → stack
#                                            #   lost. previous_vm_id is
#                                            #   auto-resolved by deploy.sh.
#   3. ./production/setup-production.sh --all # re-deploys; Step 11 re-enables
#                                            #   OIDC; kept mirror/nginx skipped

set -eu

KEEP_HOSTS="proxvex docker-registry-mirror nginx"

ASSUME_YES=0
case "${1:-}" in
  -y|--yes) ASSUME_YES=1 ;;
  -h|--help)
    sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

if ! command -v pct >/dev/null 2>&1; then
  echo "ERROR: pct not found. Run this on a Proxmox host." >&2
  exit 1
fi

# Read hostname from pct config (authoritative). Unlike `pct list`'s last
# column, this is unaffected by an optional Lock column shifting fields.
ct_hostname() {
  pct config "$1" 2>/dev/null | awk '/^hostname:/ {print $2; exit}'
}

ct_is_locked() {
  pct config "$1" 2>/dev/null | grep -q '^lock:'
}

is_kept() {
  local hostname="$1"
  for k in $KEEP_HOSTS; do
    [ "$hostname" = "$k" ] && return 0
  done
  return 1
}

ALL_VMIDS=$(pct list 2>/dev/null | awk 'NR>1 {print $1}')

# Pre-flight: every keep-host must be present. If one is missing, the
# operator should investigate before wiping anything — the whole point of
# this script is to preserve those three.
MISSING=""
for host in $KEEP_HOSTS; do
  found=0
  for vmid in $ALL_VMIDS; do
    if [ "$(ct_hostname "$vmid")" = "$host" ]; then
      found=1
      break
    fi
  done
  if [ "$found" -eq 0 ]; then
    MISSING="${MISSING}${host} "
  fi
done
if [ -n "$MISSING" ]; then
  echo "ERROR: keep-list hostname(s) not found on $(hostname): ${MISSING%% }" >&2
  echo "  Expected all of: $KEEP_HOSTS" >&2
  echo "  Aborting — investigate first; nothing has been touched." >&2
  exit 1
fi

# Build the candidate list (VMID + hostname, tab-separated, header stripped,
# keep-hosts filtered out). We resolve the hostname via pct config.

LOCKED_LIST=""
NORMAL_LIST=""
for vmid in $ALL_VMIDS; do
  hostname=$(ct_hostname "$vmid")
  [ -z "$hostname" ] && hostname="(unknown)"
  if is_kept "$hostname"; then
    continue
  fi
  if ct_is_locked "$vmid"; then
    LOCKED_LIST="${LOCKED_LIST}${vmid}	${hostname}
"
  else
    NORMAL_LIST="${NORMAL_LIST}${vmid}	${hostname}
"
  fi
done

# Phase 3 — strip orphaned OIDC enforcement from the kept deployer and
# restart it. webapp-oidc.mts gates auth purely on OIDC_ENABLED=true; with
# the OIDC_* lxc.environment lines gone the deployer comes up with no auth
# middleware, so setup-production.sh can bootstrap. Idempotent: a deployer
# without OIDC_* lines is left untouched. Safe to call even when nothing was
# destroyed (e.g. a re-run after a previous destroy-except).
neutralize_deployer_oidc() {
  echo "=== Phase 3: neutralize OIDC on kept deployer (proxvex) ==="
  local vmid deployer_vmid="" conf
  for vmid in $ALL_VMIDS; do
    if [ "$(ct_hostname "$vmid")" = "proxvex" ]; then
      deployer_vmid="$vmid"
      break
    fi
  done
  if [ -z "$deployer_vmid" ]; then
    echo "  WARN: proxvex VMID not resolved — skipping OIDC neutralization" >&2
    return 0
  fi
  conf="/etc/pve/lxc/${deployer_vmid}.conf"
  if [ -f "$conf" ] && grep -q '^lxc\.environment:[[:space:]]*OIDC_' "$conf"; then
    cp "$conf" "${conf}.bak-$(date +%s)"
    sed -i '/^lxc\.environment:[[:space:]]*OIDC_/d' "$conf"
    echo "  Stripped OIDC_* env from $conf (backup kept alongside)"
    pct stop "$deployer_vmid" 2>/dev/null || true
    if pct start "$deployer_vmid"; then
      echo "  proxvex (VMID $deployer_vmid) restarted — OIDC enforcement disabled"
    else
      echo "  WARN: pct start $deployer_vmid failed — start it manually" >&2
    fi
  else
    echo "  proxvex (VMID $deployer_vmid) has no OIDC_* env — already neutral"
  fi
  echo ""
}

if [ -z "$LOCKED_LIST" ] && [ -z "$NORMAL_LIST" ]; then
  echo "No containers to destroy (keep-list: $KEEP_HOSTS)."
  echo ""
  neutralize_deployer_oidc
  exit 0
fi

echo "Containers on $(hostname):"
echo "  Keep-list: $KEEP_HOSTS"
echo ""
if [ -n "$LOCKED_LIST" ]; then
  echo "  Phase 1 — locked, will be force-destroyed:"
  printf '%s' "$LOCKED_LIST" | awk -F'\t' 'NF==2 { printf "    VMID %-5s  %s\n", $1, $2 }'
  echo ""
fi
if [ -n "$NORMAL_LIST" ]; then
  echo "  Phase 2 — will be stopped and destroyed:"
  printf '%s' "$NORMAL_LIST" | awk -F'\t' 'NF==2 { printf "    VMID %-5s  %s\n", $1, $2 }'
  echo ""
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Type DESTROY to confirm: '
  read -r answer
  if [ "$answer" != "DESTROY" ]; then
    echo "Aborted."
    exit 1
  fi
fi

echo ""

# Phase 1 — locked containers first. A lock blocks `pct stop`/`destroy`, so
# unlock unconditionally, then force-destroy. We don't try stop here since
# the container is usually already in a broken/locked state.
if [ -n "$LOCKED_LIST" ]; then
  echo "=== Phase 1: locked containers ==="
  printf '%s' "$LOCKED_LIST" | while IFS='	' read -r vmid hostname; do
    [ -z "$vmid" ] && continue
    echo "  VMID $vmid ($hostname)"
    pct unlock "$vmid" 2>/dev/null || true
    if pct destroy "$vmid" --purge --force; then
      echo "    destroyed"
    else
      echo "    WARN: destroy returned non-zero — check manually" >&2
    fi
  done
  echo ""
fi

# Phase 2 — normal containers. Try stop first, then destroy.
if [ -n "$NORMAL_LIST" ]; then
  echo "=== Phase 2: remaining containers ==="
  printf '%s' "$NORMAL_LIST" | while IFS='	' read -r vmid hostname; do
    [ -z "$vmid" ] && continue
    echo "  VMID $vmid ($hostname)"
    pct stop "$vmid" 2>/dev/null || true
    if pct destroy "$vmid" --purge --force; then
      echo "    destroyed"
    else
      echo "    WARN: destroy returned non-zero — check manually" >&2
    fi
  done
  echo ""
fi

neutralize_deployer_oidc

echo "Done. Surviving containers:"
pct list
