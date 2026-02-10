#!/bin/sh
# Prepare /run directory for services (runs inside the container)
#
# This script prepares the /run directory by:
# 1. Ensuring /run directory exists
# 2. Optionally setting permissions for a specific user/group
# 3. Creating subdirectories if needed
#
# This is important for unprivileged containers where services need to write PID files.
#
# Requires:
#   - run_username: Username that needs write access (optional)
#   - run_group: Group name (optional)
#
# Output: JSON to stdout (errors to stderr)
exec >&2

USERNAME="{{ run_username }}"
GROUP_NAME="{{ run_group }}"

set -eu

# Ensure /run exists
if [ ! -d "/run" ]; then
  mkdir -p /run >&2
  echo "Created /run directory" >&2
fi

# If username is provided, set permissions so the user can write PID files
if [ -n "$USERNAME" ] && [ "$USERNAME" != "" ]; then
  # Determine group
  if [ -n "$GROUP_NAME" ] && [ "$GROUP_NAME" != "" ]; then
    USER_GROUP="$GROUP_NAME"
  else
    USER_GROUP="$USERNAME"
  fi
  
  # Check if user exists
  if id -u "$USERNAME" >/dev/null 2>&1; then
    # Set ownership of /run to the user/group
    # Note: In unprivileged containers, we might not be able to chown /run itself
    # But we can ensure it's writable and create subdirectories if needed
    chmod 1777 /run >&2 || {
      # If chmod fails (e.g., in unprivileged container), try 755
      chmod 755 /run >&2 || true
    }
    
    # Create a subdirectory for the service if needed
    # Some services might need a specific subdirectory
    if [ ! -d "/run/$USERNAME" ]; then
      mkdir -p "/run/$USERNAME" >&2 || true
      if [ -d "/run/$USERNAME" ]; then
        chown "$USERNAME:$USER_GROUP" "/run/$USERNAME" >&2 || true
        chmod 755 "/run/$USERNAME" >&2 || true
      fi
    fi
    
    echo "Prepared /run directory for user $USERNAME" >&2
  else
    echo "Warning: User $USERNAME does not exist, cannot set specific permissions" >&2
    chmod 755 /run >&2 || true
  fi
else
  # No username provided, just ensure /run exists with default permissions
  chmod 755 /run >&2 || true
  echo "Prepared /run directory with default permissions" >&2
fi

exit 0

