#!/bin/sh
# Upload Samba configuration and create Samba user
#
# This script:
# 1. Decodes base64-encoded smb.conf file
# 2. Writes it to /etc/samba/smb.conf
# 3. Creates UNIX user if not exists
# 4. Creates/updates Samba user with smbpasswd
# 5. Starts/restarts Samba service
#
# Requires:
#   - samba_config: Base64-encoded smb.conf file (from upload parameter)
#   - smb_user: Username for Samba authentication
#   - smb_password: Password for Samba authentication
#
# Output: JSON to stdout (errors to stderr)

SAMBA_CONFIG_B64="{{ samba_config }}"
SMB_USER="{{ smb_user }}"
SMB_PASSWORD="{{ smb_password }}"

if [ -z "$SAMBA_CONFIG_B64" ] || [ "$SAMBA_CONFIG_B64" = "" ]; then
  echo "Error: Required parameter 'samba_config' must be set" >&2
  exit 1
fi

if [ -z "$SMB_USER" ] || [ "$SMB_USER" = "" ]; then
  echo "Error: Required parameter 'smb_user' must be set" >&2
  exit 1
fi

if [ -z "$SMB_PASSWORD" ] || [ "$SMB_PASSWORD" = "" ]; then
  echo "Error: Required parameter 'smb_password' must be set" >&2
  exit 1
fi

# Ensure samba directory exists
mkdir -p /etc/samba
mkdir -p /var/lib/samba/private

# Decode and write smb.conf
echo "Writing smb.conf to /etc/samba/smb.conf..." >&2
echo "$SAMBA_CONFIG_B64" | base64 -d > /etc/samba/smb.conf
if [ $? -ne 0 ]; then
  echo "Error: Failed to decode or write smb.conf" >&2
  exit 1
fi

# Set permissions
chmod 644 /etc/samba/smb.conf

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

# Start/restart Samba service
if command -v rc-service >/dev/null 2>&1; then
  # Alpine/OpenRC
  if rc-service samba status >/dev/null 2>&1; then
    echo "Restarting Samba service (OpenRC)..." >&2
    rc-service samba restart >&2
  else
    echo "Starting Samba service (OpenRC)..." >&2
    rc-update add samba default 2>&2 || true
    rc-service samba start >&2
  fi
elif command -v systemctl >/dev/null 2>&1; then
  # Debian/Ubuntu/systemd
  if systemctl is-active --quiet smbd 2>/dev/null; then
    echo "Restarting Samba service (systemd)..." >&2
    systemctl restart smbd nmbd >&2
  else
    echo "Starting Samba service (systemd)..." >&2
    systemctl enable smbd nmbd 2>&2 || true
    systemctl start smbd nmbd >&2
  fi
fi

echo "Samba configuration and user setup completed successfully" >&2
echo '[{"id": "samba_configured", "value": "true"}]'
