#!/bin/sh
# Start LXC container on Proxmox host
#
# This script starts an LXC container by:
# 1. Checking if container exists
# 2. Starting the container if it's not already running
#
# Requires:
#   - vm_id: LXC container ID (required)
#
# Output: JSON to stdout (errors to stderr)

VMID="{{ vm_id }}"
if [ -z "$VMID" ]; then
  echo "Missing vm_id" >&2
  exit 2
fi

# Check container status first
CONTAINER_STATUS=$(pct status "$VMID" 2>/dev/null | grep -o "status: [a-z]*" | cut -d' ' -f2 || echo "unknown")
echo "Container $VMID current status: $CONTAINER_STATUS" >&2

# If container doesn't exist or is in a bad state, provide diagnostic info
if [ "$CONTAINER_STATUS" = "unknown" ] || [ -z "$CONTAINER_STATUS" ]; then
  echo "Error: Container $VMID does not exist or cannot be accessed" >&2
  echo "Diagnostic information:" >&2
  pct list 2>&1 | grep -E "(VMID|$VMID)" >&2 || echo "No containers found" >&2
  exit 1
fi

# If container is already running, exit successfully
if [ "$CONTAINER_STATUS" = "running" ]; then
  echo "Container $VMID is already running" >&2
  echo '[{"id":"started","value":"true"}]'
  exit 0
fi

# Try to start the container
echo "Attempting to start container $VMID..." >&2
if ! pct start "$VMID" >/dev/null 2>&1; then
  # Capture the original error message
  START_ERROR=$(pct start "$VMID" 2>&1)
  echo "Failed to start container $VMID" >&2
  echo "" >&2
  echo "=== Original error message ===" >&2
  echo "$START_ERROR" >&2
  echo "" >&2
  echo "=== Diagnostic information ===" >&2
  echo "Container status:" >&2
  pct status "$VMID" >&2
  echo "" >&2
  echo "Container configuration:" >&2
  pct config "$VMID" >&2 || echo "Could not read container configuration" >&2
  exit 1
fi

exit 0