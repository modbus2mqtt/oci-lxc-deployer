#!/bin/sh
# Load required kernel modules for Docker on Proxmox host
#
# This script loads the following kernel modules:
# - overlay (for overlay2 storage driver)
# - ip_tables (for IPv4 NAT/port mapping)
# - ip6_tables (for IPv6 support)
# - bridge (for Docker bridge networks)
# - br_netfilter (for bridge netfilter)
#
# Note: Modules are loaded temporarily (until reboot).
# For persistent loading, add them to /etc/modules-load.d/docker.conf
#
# Output: JSON to stdout (errors to stderr)

load_module() {
  MODULE_NAME="$1"
  if lsmod | grep -q "^${MODULE_NAME} "; then
    echo "Kernel module '$MODULE_NAME' is already loaded" >&2
    return 0
  fi
  
  echo "Loading kernel module '$MODULE_NAME'..." >&2
  if modprobe "$MODULE_NAME" 2>&1; then
    echo "Successfully loaded kernel module '$MODULE_NAME'" >&2
    return 0
  else
    echo "Warning: Failed to load kernel module '$MODULE_NAME'" >&2
    return 1
  fi
}

echo "Loading required kernel modules for Docker..." >&2

FAILED_MODULES=""
load_module "overlay" || FAILED_MODULES="${FAILED_MODULES} overlay"
load_module "ip_tables" || FAILED_MODULES="${FAILED_MODULES} ip_tables"
load_module "ip6_tables" || FAILED_MODULES="${FAILED_MODULES} ip6_tables"
load_module "bridge" || FAILED_MODULES="${FAILED_MODULES} bridge"
load_module "br_netfilter" || FAILED_MODULES="${FAILED_MODULES} br_netfilter"

if [ -n "$FAILED_MODULES" ]; then
  echo "Error: Failed to load the following kernel modules:$FAILED_MODULES" >&2
  echo "Please check if the modules are available in your kernel" >&2
  exit 1
fi

echo "All required kernel modules loaded successfully" >&2
echo '[{"id": "kernel_modules_loaded", "value": "true"}]'
