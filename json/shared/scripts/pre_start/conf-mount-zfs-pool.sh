#!/bin/sh
# Create a subdirectory under a ZFS pool mountpoint on the Proxmox host
#
# This script creates a ZFS pool subdirectory by:
# 1. Verifying that the ZFS pool exists and is mounted
# 2. Creating a subdirectory under the pool mountpoint
# 3. Setting proper permissions and ownership (uid/gid)
#
# Note: The ZFS pool must already be mounted (which is always the case in Proxmox).
#
# Requires:
#   - storage_selection: ZFS pool identifier in format "zfs:<pool_name>" (required)
#   - mountpoint: Mount point path (from context)
#   - uid: User ID for ownership (optional)
#   - gid: Group ID for ownership (optional)
#
# Script is idempotent and can be run multiple times safely.
#
# Output: JSON to stdout (errors to stderr)

STORAGE_SELECTION="{{ storage_selection}}"
UID_VALUE="{{ uid}}"
GID_VALUE="{{ gid}}"
MAPPED_UID="{{ mapped_uid}}"
MAPPED_GID="{{ mapped_gid}}"

# Check that required parameters are not empty
if [ -z "$STORAGE_SELECTION" ]; then
  echo "Error: Required parameter (storage_selection) must be set and not empty!" >&2
  exit 1
fi

# Use mapped UID/GID if provided, otherwise fall back to uid/gid parameters
if [ -n "$MAPPED_UID" ] && [ "$MAPPED_UID" != "" ]; then
  UID_VALUE="$MAPPED_UID"
fi
if [ -n "$MAPPED_GID" ] && [ "$MAPPED_GID" != "" ]; then
  GID_VALUE="$MAPPED_GID"
fi

# Parse storage selection: must be zfs:...
if ! echo "$STORAGE_SELECTION" | grep -q "^zfs:"; then
  echo "Error: Invalid storage selection format. Must start with 'zfs:'" >&2
  exit 1
fi

POOL_NAME=$(echo "$STORAGE_SELECTION" | sed 's/^zfs://')

# Check if zpool command is available
if ! command -v zpool >/dev/null 2>&1; then
  echo "Error: zpool command not found. ZFS tools are required." >&2
  exit 1
fi

# Check if zfs command is available
if ! command -v zfs >/dev/null 2>&1; then
  echo "Error: zfs command not found. ZFS tools are required." >&2
  exit 1
fi

# Verify that the ZFS pool exists
if ! zpool list "$POOL_NAME" >/dev/null 2>&1; then
  echo "Error: ZFS pool '$POOL_NAME' not found!" >&2
  exit 1
fi

# Get current mountpoint of the ZFS pool
POOL_MOUNTPOINT=$(zfs get -H -o value mountpoint "$POOL_NAME" 2>/dev/null || echo "")

# Verify pool is mounted (should always be in Proxmox)
if [ "$POOL_MOUNTPOINT" = "none" ] || [ "$POOL_MOUNTPOINT" = "-" ]; then
  echo "Error: ZFS pool '$POOL_NAME' is not mounted. In Proxmox, pools should always be mounted." >&2
  exit 1
fi

# Verify the pool mountpoint exists
if [ ! -d "$POOL_MOUNTPOINT" ]; then
  echo "Error: ZFS pool mountpoint '$POOL_MOUNTPOINT' does not exist!" >&2
  exit 1
fi

# Use the ZFS pool mountpoint directly as host_mountpoint
# e.g., /rpool, /tank, etc.
HOST_MOUNTPOINT="$POOL_MOUNTPOINT"

echo "Using ZFS pool mountpoint: $HOST_MOUNTPOINT" >&2

# Set permissions on the pool mountpoint if uid/gid are provided
# Note: This sets permissions on the pool root, which may not always be desired
# but ensures the directory is accessible for volume creation
if [ -n "$UID_VALUE" ] && [ -n "$GID_VALUE" ] && [ "$UID_VALUE" != "" ] && [ "$GID_VALUE" != "" ]; then
  # Only set permissions if we can (may fail if pool is read-only or protected)
  chown "$UID_VALUE:$GID_VALUE" "$HOST_MOUNTPOINT" 2>/dev/null || echo "Warning: Could not set ownership on $HOST_MOUNTPOINT (may be protected)" >&2
fi

echo "ZFS pool $POOL_NAME mountpoint: $HOST_MOUNTPOINT" >&2
echo '[{ "id": "host_mountpoint", "value": "'$HOST_MOUNTPOINT'" }, { "id": "shared_volpath", "value": "'$HOST_MOUNTPOINT'" }]'
exit 0

