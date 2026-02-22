#!/bin/sh
# Configure Samba service: create user and start service
#
# This script:
# 1. Creates UNIX user if not exists
# 2. Creates/updates Samba user with smbpasswd
# 3. Starts/restarts Samba service
#
# Expects smb.conf already in place (via 155-conf-upload-pre-start-files.json)
#
# Requires:
#   - smb_user: Username for Samba authentication
#   - smb_password: Password for Samba authentication
#
# Output: errors to stderr only

SMB_USER="{{ smb_user }}"
SMB_PASSWORD="{{ smb_password }}"

# Helper: check if value is defined
is_defined() {
  [ -n "$1" ] && [ "$1" != "NOT_DEFINED" ]
}

if ! is_defined "$SMB_USER"; then
  echo "Error: Required parameter 'smb_user' must be set" >&2
  exit 1
fi

if ! is_defined "$SMB_PASSWORD"; then
  echo "Error: Required parameter 'smb_password' must be set" >&2
  exit 1
fi

# Ensure samba directories exist
mkdir -p /etc/samba
mkdir -p /var/lib/samba/private

# Create UNIX user if not exists (required for smbpasswd)
if ! id "$SMB_USER" >/dev/null 2>&1; then
  echo "Creating UNIX user '$SMB_USER'..." >&2
  if command -v adduser >/dev/null 2>&1; then
    # Alpine/BusyBox style
    adduser -D -H -s /sbin/nologin "$SMB_USER" 2>&2
  elif command -v useradd >/dev/null 2>&1; then
    # Debian/Ubuntu style
    useradd -r -M -s /usr/sbin/nologin "$SMB_USER" 2>&2
  else
    echo "Error: Cannot create user - no adduser or useradd found" >&2
    exit 1
  fi
fi

# Create/update Samba user with smbpasswd
# smbpasswd reads password from stdin with -s flag
echo "Setting Samba password for user '$SMB_USER'..." >&2
printf '%s\n%s\n' "$SMB_PASSWORD" "$SMB_PASSWORD" | smbpasswd -a -s "$SMB_USER" >&2
if [ $? -ne 0 ]; then
  echo "Error: Failed to set Samba password" >&2
  exit 1
fi

# Enable the Samba user
smbpasswd -e "$SMB_USER" >&2

# Start Samba daemons
# Works in all environments: OCI containers, Alpine/OpenRC, Debian/systemd

# Kill any existing instances first
pkill smbd 2>/dev/null || true
pkill nmbd 2>/dev/null || true
sleep 1

# Start daemons directly (works everywhere)
echo "Starting smbd daemon..." >&2
smbd -D 2>&2
echo "Starting nmbd daemon..." >&2
nmbd -D 2>&2

# Additionally register with init system for auto-start on reboot (if available)
if command -v rc-update >/dev/null 2>&1; then
  # Alpine/OpenRC - register for auto-start
  echo "Registering with OpenRC for auto-start..." >&2
  rc-update add samba default 2>/dev/null || true
elif command -v systemctl >/dev/null 2>&1; then
  # Debian/Ubuntu/systemd - enable for auto-start
  echo "Registering with systemd for auto-start..." >&2
  systemctl enable smbd nmbd 2>/dev/null || true
fi

# Verify daemons are running
sleep 1
if pgrep -x smbd >/dev/null 2>&1; then
  echo "smbd is running" >&2
else
  echo "Warning: smbd failed to start" >&2
fi
if pgrep -x nmbd >/dev/null 2>&1; then
  echo "nmbd is running" >&2
else
  echo "Warning: nmbd failed to start" >&2
fi

echo "Samba user setup and service start completed successfully" >&2
