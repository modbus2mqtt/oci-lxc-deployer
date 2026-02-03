#!/bin/sh
# Set environment variables in an LXC container configuration
#
# This script sets environment variables by:
# 1. Parsing environment variables (key=value format, one per line)
# 2. Adding environment variables to LXC container configuration file
# 3. Ensuring proper formatting and avoiding duplicates
#
# Requires:
#   - vm_id: LXC container ID (from context)
#   - envs: Environment variables in key=value format, one per line (required)
#
# Script is idempotent and can be run multiple times safely.
#
# Output: JSON to stdout (errors to stderr)
exec >&2

VMID="{{ vm_id}}"
ENVS="{{ envs}}"

# Check that required parameters are not empty
if [ -z "$VMID" ]; then
  echo "Error: Required parameter 'vm_id' must be set and not empty!" >&2
  exit 1
fi

if [ -z "$ENVS" ]; then
  echo "Error: Required parameter 'envs' must be set and not empty!" >&2
  exit 1
fi

CONFIG_FILE="/etc/pve/lxc/${VMID}.conf"

# Verify that the container exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Container configuration file '$CONFIG_FILE' does not exist! Container $VMID may not exist." >&2
  exit 1
fi

# Collect existing environment variable keys (do NOT remove them - user may have added them)
EXISTING_KEYS=""
if [ -f "$CONFIG_FILE" ]; then
  EXISTING_KEYS=$(grep -E "^lxc.environment:" "$CONFIG_FILE" 2>/dev/null | sed -E 's/^lxc.environment:\s*([^=]+)=.*/\1/' | tr '\n' ' ' || true)
fi

# Use a temporary file to avoid subshell issues
TMPFILE=$(mktemp)
echo "$ENVS" > "$TMPFILE"

# Add new environment variables (only if key doesn't already exist)
ENV_COUNT=0
ENV_SKIPPED=0
while IFS= read -r line <&3; do
  # Skip empty lines
  [ -z "$line" ] && continue

  # Parse key=value format
  ENV_KEY=$(echo "$line" | cut -d'=' -f1)
  ENV_VALUE=$(echo "$line" | cut -d'=' -f2-)

  # Skip if key or value is empty
  [ -z "$ENV_KEY" ] && continue
  [ -z "$ENV_VALUE" ] && continue

  # Skip if this key already exists (preserve user-created env vars)
  case " $EXISTING_KEYS " in
    *" $ENV_KEY "*)
      echo "Skipping $ENV_KEY - environment variable already exists (preserving existing configuration)" >&2
      ENV_SKIPPED=$((ENV_SKIPPED + 1))
      continue
      ;;
  esac

  # Add as LXC environment configuration (format: lxc.environment: KEY=VALUE)
  echo "lxc.environment: $ENV_KEY=$ENV_VALUE" >> "$CONFIG_FILE" 2>&1
  echo "Set environment variable $ENV_KEY=$ENV_VALUE for container $VMID" >&2
  ENV_COUNT=$((ENV_COUNT + 1))
done 3< "$TMPFILE"
rm -f "$TMPFILE"

echo "Successfully set $ENV_COUNT environment variable(s) for container $VMID (skipped $ENV_SKIPPED existing)" >&2
exit 0



