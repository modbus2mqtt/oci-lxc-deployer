#!/bin/sh
# Usage: create-user.sh <username> <uid> <gid> <mountpoint>
#
# create-user.sh: Creates a user with specified username, UID, GID, and home directory (no password, no login).
#
# - Creates group and user if not present
# - Sets up home directory
#
# All output is sent to stderr. Script is POSIX-compliant and produces no output on stdout.

USERNAME="{{ username }}"
UID="{{ uid }}"
GID="{{ gid }}"
MOUNTPOINT="{{ mountpoint }}"

# Check that all parameters are not empty
if [ -z "$USERNAME" ] || [ -z "$UID" ] || [ -z "$GID" ]; then
  echo "Error: Parameters (username, uid, gid) must be set and not empty!" >&2
  exit 1
fi

# 1. Create group if not exists
if ! getent group "$USERNAME" >/dev/null 2>&1; then
  if ! getent group "$GID" >/dev/null 2>&1; then
    groupadd -g "$GID" "$USERNAME" 1>&2
  else
    groupadd "$USERNAME" 1>&2
  fi
fi

# 2. Create user if not exists
if ! id -u "$USERNAME" >/dev/null 2>&1; then
  useradd -u "$UID" -g "$GID" -M -N -s /usr/sbin/nologin -d "/home/$USERNAME" "$USERNAME" 1>&2
  mkdir -p "/home/$USERNAME" 1>&2
  chown "$UID:$GID" "/home/$USERNAME" 1>&2
fi

