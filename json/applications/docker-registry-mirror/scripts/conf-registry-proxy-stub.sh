#!/bin/sh
# Patch /etc/distribution/config.yml in the LXC's rootfs volume BEFORE the
# LXC starts, according to the {{ mode }} application property. See the
# template description for the underlying Distribution-scheduler bug.
set -eu

VM_ID="{{ vm_id }}"
MODE="{{ mode }}"
log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$VM_ID" ] || [ "$VM_ID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi
# Default to proxy when the property is missing (application.json sets it to
# 'proxy' as a locked value; the fallback covers older deployments that
# pre-date that property).
if [ -z "$MODE" ] || [ "$MODE" = "NOT_DEFINED" ]; then
  MODE="proxy"
fi

# Resolve the rootfs volume's host filesystem path so we can edit
# /etc/distribution/config.yml directly. Works on zfspool/dir/lvm-backed
# rootfs alike (pvesm path is the common abstraction).
ROOTFS_VOLID=$(pct config "$VM_ID" 2>/dev/null \
  | sed -nE 's/^rootfs: ([^,]+),.*$/\1/p')
if [ -z "$ROOTFS_VOLID" ]; then
  fail "Could not read rootfs volid from pct config $VM_ID"
fi
ROOTFS_PATH=$(pvesm path "$ROOTFS_VOLID" 2>/dev/null || true)
if [ -z "$ROOTFS_PATH" ] || [ ! -d "$ROOTFS_PATH" ]; then
  fail "Could not resolve rootfs path for $ROOTFS_VOLID (got: $ROOTFS_PATH)"
fi

CONFIG="${ROOTFS_PATH}/etc/distribution/config.yml"
if [ ! -f "$CONFIG" ]; then
  log "Distribution config $CONFIG not found in rootfs — nothing to patch"
  echo '[{"id":"registry_proxy_stub","value":"missing"}]'
  exit 0
fi

case "$MODE" in
  proxy)
    # Append a `proxy:` stub so REGISTRY_PROXY_REMOTEURL etc. take effect.
    # Idempotent: skip if already present at column 0 (avoids matching
    # nested keys like `cache: blobdescriptor:`).
    if grep -qE '^proxy:' "$CONFIG"; then
      log "$CONFIG already has a proxy: block — leaving as is"
      echo '[{"id":"registry_mode","value":"proxy-present"}]'
      exit 0
    fi
    printf '\nproxy: {}\n' >> "$CONFIG"
    log "Appended 'proxy: {}' stub to $CONFIG (mode=proxy)"
    echo '[{"id":"registry_mode","value":"proxy-added"}]'
    ;;
  readwrite)
    # Private push-target registry. NOT recommended for pull-through caches —
    # Distribution's filesystem driver schedules blob deletion on a 7-day TTL,
    # so a cache that's only read-from (not pushed-to) self-destructs.
    log "mode=readwrite — leaving $CONFIG untouched (Distribution default)"
    echo '[{"id":"registry_mode","value":"readwrite"}]'
    ;;
  readonly)
    # Frozen corpus, e.g. for air-gapped serving of a pre-populated cache.
    # Add `maintenance.readonly.enabled: true` if not already present.
    if grep -qE '^\s+readonly:\s*$' "$CONFIG"; then
      log "$CONFIG already declares a readonly block — leaving as is"
      echo '[{"id":"registry_mode","value":"readonly-present"}]'
      exit 0
    fi
    fail "mode=readonly: stub does not yet implement the readonly patch; extend conf-registry-proxy-stub.sh when this becomes needed"
    ;;
  *)
    fail "Unknown mode '$MODE' — application property 'mode' must be one of: proxy | readwrite | readonly"
    ;;
esac
