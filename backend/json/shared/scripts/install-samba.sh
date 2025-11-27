
#!/bin/sh
# Installs Samba, configures a share for the given mountpoint, and enables access for the specified user.
# All output is sent to stderr. No output on stdout.

MOUNTPOINT="{{ mountpoint }}"
USERNAME="{{ username }}"
PASSWORD="{{ password }}"

# Check that all parameters are not empty
if [ -z "$MOUNTPOINT" ] || [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
  echo "Error: All parameters (mountpoint, username, password) must be set and not empty!" >&2
  exit 1
fi

# 1. Install samba
apk add --no-cache samba 1>&2


# 2. Check if user exists (must be created beforehand)
if ! id "$USERNAME" >/dev/null 2>&1; then
  echo "Error: User $USERNAME does not exist. Please create the user before running this script." >&2
  exit 1
fi

# 3. Set samba password for user
printf "%s\n%s\n" "$PASSWORD" "$PASSWORD" | smbpasswd -a -s "$USERNAME" 1>&2

# 4. Create share config
SHARE_NAME=$(basename "$MOUNTPOINT")
CONF_DIR="/etc/samba/conf.d"
CONF_FILE="$CONF_DIR/$SHARE_NAME.conf"

mkdir -p "$CONF_DIR"

cat > "$CONF_FILE" <<EOF
[global]
  workgroup = WORKGROUP
  server role = standalone server
  security = user
  wide links = yes
  unix extensions = no
  vfs object = acl_xattr catia fruit streams_xattr
  fruit:nfc_aces = no
  fruit:aapl = yes
  fruit:model = MacSamba
  fruit:posix_rename = yes
  fruit:metadata = stream
  fruit:delete_empty_adfiles = yes
  fruit:veto_appledouble = no
  spotlight = yes

[$SHARE_NAME]
  path = $MOUNTPOINT
  available = yes
  writable = yes
  guest ok = no
  valid users = $USERNAME
  vfs objects = catia fruit streams_xattr
  fruit:time machine = yes
  force user = $USERNAME
  force group = $USERNAME
EOF

# 5. Ensure include = /etc/samba/conf.d/*.conf in main smb.conf
if ! grep -q 'include = /etc/samba/conf.d/*.conf' /etc/samba/smb.conf 2>/dev/null; then
  echo "\ninclude = /etc/samba/conf.d/*.conf" >> /etc/samba/smb.conf
fi

# 6. Restart samba
rc-service samba restart 1>&2 || service samba restart 1>&2

echo "Samba share $SHARE_NAME for $USERNAME on $MOUNTPOINT configured." >&2
