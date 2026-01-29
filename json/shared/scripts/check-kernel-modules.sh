#!/bin/sh
# Check if required kernel modules for Docker are loaded on Proxmox host
#
# This script checks if the following kernel modules are loaded:
# - overlay (for overlay2 storage driver)
# - ip_tables (for IPv4 NAT/port mapping)
# - ip6_tables (for IPv6 support)
# - bridge (for Docker bridge networks)
# - br_netfilter (for bridge netfilter)
#
# Output: JSON to stdout (errors to stderr)
# Exits with error code if any module is missing

MISSING_MODULES=""

# Check each required module
check_module() {
  MODULE_NAME="$1"
  if ! lsmod | grep -q "^${MODULE_NAME} "; then
    if [ -z "$MISSING_MODULES" ]; then
      MISSING_MODULES="$MODULE_NAME"
    else
      MISSING_MODULES="$MISSING_MODULES $MODULE_NAME"
    fi
    echo "Error: Kernel module '$MODULE_NAME' is not loaded" >&2
  else
    echo "Kernel module '$MODULE_NAME' is loaded" >&2
  fi
}

echo "Checking required kernel modules for Docker..." >&2

check_module "overlay"
check_module "ip_tables"
check_module "ip6_tables"
check_module "bridge"
check_module "br_netfilter"

if [ -n "$MISSING_MODULES" ]; then
  echo "Error: The following kernel modules are not loaded: $MISSING_MODULES" >&2
  echo "Please run template '096-load-kernel-modules' to load them, or load them manually:" >&2
  for mod in $MISSING_MODULES; do
    echo "  modprobe $mod" >&2
  done
  exit 1
fi

echo "All required kernel modules are loaded" >&2
echo '[{"id": "kernel_modules_ok", "value": "true"}]'
