#!/bin/sh
# Stop LXC container on Proxmox host
#
# This script stops an LXC container by:
# 1. Checking if container exists
# 2. Stopping the container if it's running
# 3. Waiting until the container is stopped
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

# If container is already stopped, exit successfully
if [ "$CONTAINER_STATUS" = "stopped" ]; then
  echo "Container $VMID is already stopped" >&2
  echo '[{"id":"stopped","value":"true"}]'
  exit 0
fi

# Try to stop the container
echo "Attempting to stop container $VMID..." >&2
if ! pct stop "$VMID" >/dev/null 2>&1; then
  # Capture the original error message
  STOP_ERROR=$(pct stop "$VMID" 2>&1)
  echo "Failed to stop container $VMID" >&2
  echo "" >&2
  echo "=== Original error message ===" >&2
  echo "$STOP_ERROR" >&2
  echo "" >&2
  echo "=== Diagnostic information ===" >&2
  echo "Container status:" >&2
  pct status "$VMID" >&2
  exit 1
fi

# Wait for container to be stopped (max 60 seconds)
MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  CONTAINER_STATUS=$(pct status "$VMID" 2>/dev/null | grep -o "status: [a-z]*" | cut -d' ' -f2 || echo "unknown")
  if [ "$CONTAINER_STATUS" = "stopped" ]; then
    echo "Container $VMID stopped successfully" >&2
    exit 0
  fi
  echo "Waiting for container to stop... ($WAITED/$MAX_WAIT seconds)" >&2
  sleep 1
  WAITED=$((WAITED + 1))
done

echo "Timeout waiting for container $VMID to stop" >&2
exit 1
