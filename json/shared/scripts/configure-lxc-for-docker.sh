#!/bin/sh
# Configure LXC container for Docker support
#
# This script configures LXC container by:
# 1. Adding cgroup2 device permissions
# 2. Setting AppArmor profile to unconfined
# 3. Allowing all capabilities
#
# Requires:
#   - vm_id: LXC container ID (from context)
#
# Output: JSON to stdout (errors to stderr)

VMID="{{ vm_id }}"
CONFIG_FILE="/etc/pve/lxc/${VMID}.conf"

if [ -z "$VMID" ]; then
  echo "Error: Required parameter 'vm_id' must be set" >&2
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Container config file '$CONFIG_FILE' does not exist" >&2
  exit 1
fi

# Check if container is running (needs to be stopped for config changes)
if pct status "$VMID" 2>/dev/null | grep -q 'status: running'; then
  echo "Warning: Container $VMID is running. Stopping container for configuration changes..." >&2
  pct stop "$VMID" >&2 || {
    echo "Error: Failed to stop container $VMID" >&2
    exit 1
  }
fi

# Remove existing Docker-related config entries
sed -i '/^lxc.cgroup2.devices.allow/d' "$CONFIG_FILE"
sed -i '/^lxc.cgroup2.devices.deny/d' "$CONFIG_FILE"
sed -i '/^lxc.apparmor.profile/d' "$CONFIG_FILE"
sed -i '/^lxc.cap.drop/d' "$CONFIG_FILE"

# Add cgroup2 device permissions (required for Docker)
echo "lxc.cgroup2.devices.allow = c *:* rwm" >> "$CONFIG_FILE"
echo "lxc.cgroup2.devices.allow = b *:* rwm" >> "$CONFIG_FILE"
echo "lxc.cgroup2.devices.deny = a" >> "$CONFIG_FILE"

# Allow unconfined AppArmor (required for Docker)
echo "lxc.apparmor.profile = unconfined" >> "$CONFIG_FILE"

# Drop no capabilities (allow all - required for Docker)
echo "lxc.cap.drop =" >> "$CONFIG_FILE"

echo "LXC container $VMID configured for Docker support" >&2
echo "Note: Container restart required for changes to take effect" >&2

echo '[{"id": "lxc_configured", "value": "true"}]'
