#!/bin/sh
# List available storage options on the VE host
#
# This script lists available storage by:
# 1. Scanning for unmounted block devices (by UUID)
# 2. Scanning for mounted ZFS pools
# 3. Formatting as JSON array for enumValues
#
# Output format: JSON array of objects with name and value fields
# Example: [{"name":"sda1 (ext4)","value":"uuid:1234-5678"}, {"name":"tank (ZFS)","value":"zfs:tank"}, ...]
#
# Note:
#   - For filesystems: only unmounted partitions are included
#   - For ZFS pools: only mounted pools are included (as they are always mounted in Proxmox)
#   - Values are prefixed: uuid: for filesystems, zfs: for ZFS pools
#
# Output: JSON to stdout (errors to stderr)

set -eu

# Timeout for commands that might hang
# Reduced timeouts for faster failure in test contexts
TIMEOUT_CMD="timeout"
if ! command -v timeout >/dev/null 2>&1; then
  # Fallback: use gtimeout on macOS or skip timeout
  if command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_CMD="gtimeout"
  else
    TIMEOUT_CMD=""
  fi
fi

# Helper function to run command with timeout
run_with_timeout() {
  local timeout_sec="${1:-1}"
  shift
  if [ -n "$TIMEOUT_CMD" ]; then
    $TIMEOUT_CMD "$timeout_sec" "$@" 2>/dev/null || return 1
  else
    # If timeout command not available, try to run but fail fast if command doesn't exist
    if ! command -v "$1" >/dev/null 2>&1; then
      return 1
    fi
    "$@" 2>/dev/null || return 1
  fi
}

warn() {
  echo "$*" >&2
}

FIRST=true
printf '['

add_item() {
  # add_item <name> <value>
  _name="$1"
  _value="$2"
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    printf ','
  fi
  printf '{"name":"%s","value":"%s"}' "$_name" "$_value"
}

# Ensure we can query mounts; if not, treat as empty.
MOUNTED_DEVICES=""
if command -v mount >/dev/null 2>&1; then
  MOUNTED_DEVICES=$(run_with_timeout 1 mount | awk '{print $1}' | grep -E '^/dev/' | sort -u || echo "")
fi

# Track ZFS pools (optional)
IMPORTED_POOLS=$(run_with_timeout 1 zpool list -H -o name 2>/dev/null || echo "")

HAS_SYS_BLOCK=false
if [ -d "/sys/block" ] && [ -r "/sys/block" ]; then
  HAS_SYS_BLOCK=true
fi

HAS_LSBLK=false
if command -v lsblk >/dev/null 2>&1; then
  HAS_LSBLK=true
fi

HAS_BLKID=false
if command -v blkid >/dev/null 2>&1; then
  HAS_BLKID=true
fi

UUID_DIR="/dev/disk/by-uuid"
HAS_UUID_DIR=false
if [ -d "$UUID_DIR" ]; then
  HAS_UUID_DIR=true
fi

if [ "$HAS_LSBLK" = true ] && [ "$HAS_SYS_BLOCK" = true ]; then
  TMP_LSBLK="$(mktemp 2>/dev/null || true)"
  if [ -z "$TMP_LSBLK" ]; then
    warn "Warning: mktemp failed; skipping block device scan"
  else
    trap 'rm -f "$TMP_LSBLK" 2>/dev/null || true' EXIT
    if run_with_timeout 2 lsblk -n -o NAME,TYPE,FSTYPE,SIZE,MOUNTPOINT 2>/dev/null >"$TMP_LSBLK"; then
      while IFS= read -r line; do
        NAME=$(echo "$line" | awk '{print $1}')
        TYPE=$(echo "$line" | awk '{print $2}')
        FSTYPE=$(echo "$line" | awk '{print $3}')
        SIZE=$(echo "$line" | awk '{print $4}')
        MOUNTPOINT=$(echo "$line" | awk '{print $5}')

        [ "$TYPE" != "part" ] && continue
        [ -n "$MOUNTPOINT" ] && continue
        echo "$MOUNTED_DEVICES" | grep -q "^/dev/$NAME$" && continue
        [ "$FSTYPE" = "zfs" ] && continue

        if [ -z "$FSTYPE" ] && [ "$HAS_BLKID" = true ]; then
          FSTYPE=$(run_with_timeout 1 blkid -s TYPE -o value "/dev/$NAME" 2>/dev/null || echo "")
        fi
        [ -z "$FSTYPE" ] && continue

        UUID=""
        if [ "$HAS_BLKID" = true ]; then
          UUID=$(run_with_timeout 1 blkid -s UUID -o value "/dev/$NAME" 2>/dev/null || echo "")
        fi
        [ -z "$UUID" ] && continue

        if [ -n "$SIZE" ]; then
          NAME_TEXT="${NAME} (${FSTYPE}, ${SIZE})"
        else
          NAME_TEXT="${NAME} (${FSTYPE})"
        fi

        add_item "$NAME_TEXT" "uuid:${UUID}"
      done <"$TMP_LSBLK"
    fi
    rm -f "$TMP_LSBLK" 2>/dev/null || true
  fi
elif [ "$HAS_UUID_DIR" = true ]; then
  # Fallback without lsblk: enumerate by-uuid symlinks
  for UUID_LINK in "$UUID_DIR"/*; do
    [ ! -e "$UUID_LINK" ] && continue
    UUID=$(basename "$UUID_LINK")
    DEV=$(readlink -f "$UUID_LINK" 2>/dev/null || echo "")
    [ -z "$DEV" ] && continue
    echo "$DEV" | grep -Eq '^/dev/' || continue

    # Skip if mounted
    echo "$MOUNTED_DEVICES" | grep -Fqx "$DEV" && continue

    FSTYPE=""
    if [ "$HAS_BLKID" = true ]; then
      FSTYPE=$(run_with_timeout 1 blkid -s TYPE -o value "$DEV" 2>/dev/null || echo "")
    fi
    [ -z "$FSTYPE" ] && continue
    [ "$FSTYPE" = "zfs" ] && continue

    NAME_TEXT="$(basename "$DEV") (${FSTYPE})"
    add_item "$NAME_TEXT" "uuid:${UUID}"
  done
else
  # No block device enumeration available (common in macOS/dev/test contexts)
  if [ "$HAS_LSBLK" = false ]; then
    warn "Warning: lsblk not found; skipping filesystem partition scan"
  fi
  if [ "$HAS_SYS_BLOCK" = false ]; then
    warn "Warning: /sys/block not accessible; skipping filesystem partition scan"
  fi
fi

# List ZFS pools that are imported and mounted
# In Proxmox, ZFS pools are always mounted, so we list all imported pools
if [ -n "$IMPORTED_POOLS" ]; then
  echo "$IMPORTED_POOLS" | while IFS= read -r POOL_NAME; do
    [ -z "$POOL_NAME" ] && continue

    POOL_MOUNTPOINT=$(run_with_timeout 1 zfs get -H -o value mountpoint "$POOL_NAME" 2>/dev/null || echo "")
    [ "$POOL_MOUNTPOINT" = "none" ] && continue
    [ "$POOL_MOUNTPOINT" = "-" ] && continue
    [ ! -d "$POOL_MOUNTPOINT" ] && continue

    POOL_SIZE=$(run_with_timeout 1 zpool list -H -o size "$POOL_NAME" 2>/dev/null || echo "")
    if [ -n "$POOL_SIZE" ]; then
      NAME_TEXT="ZFS Pool: ${POOL_NAME} (${POOL_SIZE})"
    else
      NAME_TEXT="ZFS Pool: ${POOL_NAME}"
    fi

    add_item "$NAME_TEXT" "zfs:${POOL_NAME}"
  done
fi

printf ']'
printf '\n'
exit 0
