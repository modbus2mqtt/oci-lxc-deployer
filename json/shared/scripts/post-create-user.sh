#!/bin/sh
# Create a system user (runs inside the container)
#
# This script creates a system user by:
# 1. Creating group with optional GID
# 2. Creating user with optional UID
# 3. Setting up home directory
# 4. Configuring user without password and login shell
#
# Supports both Alpine Linux (addgroup/adduser) and Debian/Ubuntu (groupadd/useradd)
#
# Requires:
#   - username: Username to create (required)
#   - uid: User ID (optional, system assigns if not provided)
#   - gid: Group ID (optional, system assigns if not provided)
#
# Output: JSON to stdout (errors to stderr)
exec >&2
# All output is sent to stderr. Script is POSIX-compliant and produces no output on stdout.
set -e
USERNAME="{{ username }}"
UID_VALUE="{{ uid }}"
GID_VALUE="{{ gid }}"

# Check that username is not empty
if [ -z "$USERNAME" ]; then
  echo "Error: Username must be set and not empty!" >&2
  exit 1
fi

# Detect system type (Alpine uses addgroup/adduser, Debian uses groupadd/useradd)
# Note: Debian/Ubuntu has both, so we check for useradd/groupadd first (preferred for scripts)
if command -v groupadd >/dev/null 2>&1 && command -v useradd >/dev/null 2>&1; then
  # Debian/Ubuntu (useradd/groupadd are standard for non-interactive use)
  SYSTEM_TYPE="debian"
  GROUPADD_CMD="groupadd"
  USERADD_CMD="useradd"
elif command -v addgroup >/dev/null 2>&1 && command -v adduser >/dev/null 2>&1; then
  # Alpine Linux (only has addgroup/adduser)
  SYSTEM_TYPE="alpine"
  GROUPADD_CMD="addgroup"
  USERADD_CMD="adduser"
else
  echo "Error: Neither Debian (groupadd/useradd) nor Alpine (addgroup/adduser) commands found!" >&2
  exit 1
fi

# Helper function to retry a command with exponential backoff
retry_command() {
  local cmd="$1"
  local max_attempts=5
  local attempt=1
  local delay=1
  local last_error=""
  
  while [ $attempt -le $max_attempts ]; do
    # Capture both stdout and stderr, but redirect stderr to stdout for capture
    last_error=$(eval "$cmd" 2>&1)
    local exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
      # Success - output the result to stderr (for visibility)
      echo "$last_error" >&2
      return 0
    fi
    
    if [ $attempt -lt $max_attempts ]; then
      echo "Attempt $attempt failed: $last_error" >&2
      echo "Retrying in ${delay}s..." >&2
      sleep "$delay"
      delay=$((delay * 2))  # Exponential backoff: 1s, 2s, 4s, 8s
      attempt=$((attempt + 1))
    else
      # Last attempt failed - show the error
      echo "Final attempt failed: $last_error" >&2
      return 1
    fi
  done
  return 1
}

# 1. Create group if not exists
GROUP_CREATED=0
if ! getent group "$USERNAME" >/dev/null 2>&1; then
  GROUP_CREATED=1
  if [ -n "$GID_VALUE" ] && [ "$GID_VALUE" != "" ]; then
    # Check if GID is already in use
    if ! getent group "$GID_VALUE" >/dev/null 2>&1; then
      if [ "$SYSTEM_TYPE" = "alpine" ]; then
        if ! retry_command "$GROUPADD_CMD -g \"$GID_VALUE\" \"$USERNAME\""; then
          echo "Error: Failed to create group $USERNAME with GID $GID_VALUE after retries" >&2
          exit 1
        fi
      else
        if ! retry_command "$GROUPADD_CMD -g \"$GID_VALUE\" \"$USERNAME\""; then
          echo "Error: Failed to create group $USERNAME with GID $GID_VALUE after retries" >&2
          exit 1
        fi
      fi
    else
      # GID is in use, create group without specifying GID
      echo "Warning: GID $GID_VALUE is already in use, creating group with auto-assigned GID" >&2
      if ! retry_command "$GROUPADD_CMD \"$USERNAME\""; then
        echo "Error: Failed to create group $USERNAME after retries" >&2
        exit 1
      fi
    fi
  else
    # No GID specified, create group with auto-assigned GID
    if ! retry_command "$GROUPADD_CMD \"$USERNAME\""; then
      echo "Error: Failed to create group $USERNAME after retries" >&2
      exit 1
    fi
  fi
fi

# Get the actual GID of the group (may have been auto-assigned)
ACTUAL_GID=$(getent group "$USERNAME" | cut -d: -f3)

if [ "$GROUP_CREATED" -eq 1 ]; then
  echo "Group '$USERNAME' created successfully with GID:$ACTUAL_GID" >&2
fi

# 2. Create user if not exists
USER_CREATED=0
# Special case: if username is "root" and uid is 0, root already exists, skip creation
if [ "$USERNAME" = "root" ] && [ -n "$UID_VALUE" ] && [ "$UID_VALUE" = "0" ]; then
  echo "User 'root' already exists, skipping creation" >&2
  ACTUAL_UID="0"
  ACTUAL_GID="0"
elif ! id -u "$USERNAME" >/dev/null 2>&1; then
  if [ -n "$UID_VALUE" ] && [ "$UID_VALUE" != "" ]; then
    # UID specified, use it
    if [ "$SYSTEM_TYPE" = "alpine" ]; then
      # Alpine adduser: -D = don't assign password, -h = home dir, -s = shell, -G = group, -u = uid
      if ! retry_command "$USERADD_CMD -D -h \"/home/$USERNAME\" -s /sbin/nologin -G \"$USERNAME\" -u \"$UID_VALUE\" \"$USERNAME\""; then
        echo "Error: Failed to create user $USERNAME with UID $UID_VALUE after retries" >&2
        exit 1
      fi
    else
      # Debian useradd: -u = uid, -g = group, -M = no home, -N = no group, -s = shell, -d = home dir
      if ! retry_command "$USERADD_CMD -u \"$UID_VALUE\" -g \"$ACTUAL_GID\" -M -N -s /usr/sbin/nologin -d \"/home/$USERNAME\" \"$USERNAME\""; then
        echo "Error: Failed to create user $USERNAME with UID $UID_VALUE after retries" >&2
        exit 1
      fi
    fi
    ACTUAL_UID="$UID_VALUE"
  else
    # No UID specified, let system assign it
    if [ "$SYSTEM_TYPE" = "alpine" ]; then
      if ! retry_command "$USERADD_CMD -D -h \"/home/$USERNAME\" -s /sbin/nologin -G \"$USERNAME\" \"$USERNAME\""; then
        echo "Error: Failed to create user $USERNAME after retries" >&2
        exit 1
      fi
    else
      if ! retry_command "$USERADD_CMD -g \"$ACTUAL_GID\" -M -N -s /usr/sbin/nologin -d \"/home/$USERNAME\" \"$USERNAME\""; then
        echo "Error: Failed to create user $USERNAME after retries" >&2
        exit 1
      fi
    fi
    ACTUAL_UID=$(id -u "$USERNAME")
  fi
  # Create home directory and set permissions
  # Alpine adduser creates it by default, Debian useradd -M doesn't, so always create it
  mkdir -p "/home/$USERNAME" 1>&2
  chown "$ACTUAL_UID:$ACTUAL_GID" "/home/$USERNAME" 1>&2
  USER_CREATED=1
fi

# Get actual UID and GID (in case user already existed)
ACTUAL_UID=$(id -u "$USERNAME" 2>/dev/null || echo "")
ACTUAL_GID=$(id -g "$USERNAME" 2>/dev/null || echo "")

# Output result
if [ "$USER_CREATED" -eq 1 ]; then
  echo "User '$USERNAME' created successfully with UID:$ACTUAL_UID GID:$ACTUAL_GID" >&2
else
  echo "User '$USERNAME' already exists with UID:$ACTUAL_UID GID:$ACTUAL_GID" >&2
fi

