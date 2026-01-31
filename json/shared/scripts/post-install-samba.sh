#!/bin/sh
# Install Samba and configure multiple shares
#
# This script installs and configures Samba by:
# 1. Installing Samba packages (supports Alpine Linux apk and Debian/Ubuntu apt)
# 2. Creating Samba user with specified credentials
# 3. Creating shares for all volumes from 'Bind Multiple Volumes to LXC' (160)
# 4. Optionally configuring additional custom shares
# 5. Enabling and starting Samba service
#
# Requires:
#   - username: Samba username (required)
#   - password: Samba password (required)
#   - volumes: Volume mappings from template 160 (optional, auto-detected)
#   - additional_shares: Additional share configurations (optional)
#   - uid: User ID (optional)
#   - gid: Group ID (optional)
#
# Supports both Alpine Linux (apk) and Debian/Ubuntu (apt-get/apt)
#
# Output: JSON to stdout (errors to stderr)

set -e

USERNAME="{{ username }}"
PASSWORD="{{ password }}"
VOLUMES="{{ volumes }}"
ADDITIONAL_SHARES="{{ additional_shares }}"
UID_VALUE="{{ uid }}"
GID_VALUE="{{ gid }}"
ALLOW_GUEST="{{ allow-guest }}"

# Global variables for service management
SERVICE_CMD=""
SERVICE_ENABLE_CMD=""
SERVICE_STATUS_CMD=""
SERVICE_IS_ACTIVE_CMD=""
SHARE_COUNT=0

# Detect service manager and set OS-specific command variables
detect_service_manager() {
  if command -v rc-service >/dev/null 2>&1; then
    # Alpine Linux with OpenRC
    SERVICE_CMD="rc-service"
    SERVICE_ENABLE_CMD="rc-update add"
    SERVICE_STATUS_CMD="rc-service status"
    SERVICE_IS_ACTIVE_CMD="rc-service status"
  elif command -v systemctl >/dev/null 2>&1; then
    # Debian/Ubuntu with systemd
    SERVICE_CMD="systemctl"
    SERVICE_ENABLE_CMD="systemctl enable"
    SERVICE_STATUS_CMD="systemctl status"
    SERVICE_IS_ACTIVE_CMD="systemctl is-active --quiet"
  elif command -v service >/dev/null 2>&1; then
    # Fallback for sysvinit
    SERVICE_CMD="service"
    SERVICE_ENABLE_CMD="service enable"
    SERVICE_STATUS_CMD="service status"
    SERVICE_IS_ACTIVE_CMD="service status"
  fi
}

# Check if Samba VFS modules are available (for Alpine Linux)
check_samba_modules() {
  if command -v apk >/dev/null 2>&1; then
    # Alpine Linux: Check if VFS modules are available (required for Time Machine)
    VFS_DIRS="/usr/lib/samba/vfs /usr/lib64/samba/vfs /usr/lib/x86_64-linux-gnu/samba/vfs"
    MODULES_FOUND=0
    for VFS_DIR in $VFS_DIRS; do
      if [ -d "$VFS_DIR" ]; then
        if [ -f "$VFS_DIR/fruit.so" ] && [ -f "$VFS_DIR/streams_xattr.so" ]; then
          MODULES_FOUND=1
          echo "Found Samba VFS modules in $VFS_DIR" >&2
          break
        fi
      fi
    done
    if [ "$MODULES_FOUND" -eq 0 ]; then
      echo "Warning: Samba VFS modules (fruit.so or streams_xattr.so) not found in standard locations" >&2
      echo "Warning: macOS Time Machine may not work properly without these modules" >&2
      echo "Warning: Checked directories: $VFS_DIRS" >&2
    fi
  fi
}

# Setup Samba user and password
setup_samba_user() {
  # Check if user exists (must be created beforehand)
  if ! id "$USERNAME" >/dev/null 2>&1; then
    echo "Error: User $USERNAME does not exist. Please create the user before running this script." >&2
    exit 1
  fi
  
  # Verify user has correct UID/GID if provided
  if [ -n "$UID_VALUE" ] && [ -n "$GID_VALUE" ] && [ "$UID_VALUE" != "" ] && [ "$GID_VALUE" != "" ]; then
    local user_uid=$(id -u "$USERNAME" 2>/dev/null || echo "")
    local user_gid=$(id -g "$USERNAME" 2>/dev/null || echo "")
    
    if [ -n "$user_uid" ] && [ -n "$user_gid" ]; then
      if [ "$user_uid" != "$UID_VALUE" ] || [ "$user_gid" != "$GID_VALUE" ]; then
        echo "Warning: User $USERNAME has UID:$user_uid GID:$user_gid, but expected $UID_VALUE:$GID_VALUE" >&2
        echo "Warning: This may cause permission issues with bind mounts from the host." >&2
        echo "Warning: Ensure the user is created with the correct UID/GID (e.g., via create-user template)." >&2
      fi
    fi
  fi

  # Set samba password for user
  if ! printf "%s\n%s\n" "$PASSWORD" "$PASSWORD" | smbpasswd -a -s "$USERNAME" 1>&2; then
    echo "Error: Failed to set Samba password for user $USERNAME" >&2
    exit 1
  fi
}

# Configure global Samba settings for macOS Time Machine
# Note: Shares will be appended to this file by create_all_shares()
configure_global_samba() {
  # Backup original smb.conf if it exists and hasn't been backed up yet
  if [ -f /etc/samba/smb.conf ] && [ ! -f /etc/samba/smb.conf.orig ]; then
    cp /etc/samba/smb.conf /etc/samba/smb.conf.orig 1>&2
  fi

  # Create a clean, new smb.conf with only our configuration
  # This avoids issues with default shares like [homes], [printers], etc.
  # Shares will be appended to this file by create_all_shares()
  
  # Determine guest access settings
  local map_to_guest="Never"
  local guest_ok_global="no"
  if [ "$ALLOW_GUEST" = "true" ] || [ "$ALLOW_GUEST" = "1" ]; then
    map_to_guest="Bad User"
    guest_ok_global="yes"
  fi
  
  cat > /etc/samba/smb.conf <<EOF
[global]
  workgroup = WORKGROUP
  server role = standalone server
  server string = Samba Time Machine Server
  security = user
  map to guest = $map_to_guest
  guest ok = $guest_ok_global
  wide links = yes
  unix extensions = no
  vfs objects = acl_xattr catia fruit streams_xattr
  fruit:nfc_aces = no
  fruit:aapl = yes
  fruit:model = MacSamba
  fruit:posix_rename = yes
  fruit:metadata = stream
  fruit:delete_empty_adfiles = yes
  fruit:veto_appledouble = no
  spotlight = yes
  log file = /var/log/samba/log.%m
  max log size = 1000
  logging = file

EOF

  echo "Created clean Samba configuration file" >&2
}

# Create a single Samba share configuration and append to smb.conf
create_share_config() {
  local share_name="$1"
  local share_path="$2"
  
  # Ensure share path starts with /
  if [ "$(echo "$share_path" | cut -c1)" != "/" ]; then
    share_path="/$share_path"
  fi
  
  # Ensure mountpoint exists
  if [ ! -d "$share_path" ]; then
    echo "Warning: Share path $share_path does not exist, creating it" >&2
    mkdir -p "$share_path" >&2
  fi
  
  # Set permissions on share path using provided uid/gid
  # Note: For bind mounts from the host, permissions must be set on the host.
  # This is a best-effort attempt to set them in the container as well.
  if [ -n "$UID_VALUE" ] && [ -n "$GID_VALUE" ] && [ "$UID_VALUE" != "" ] && [ "$GID_VALUE" != "" ]; then
    # Check if this is a bind mount (read-only filesystem or owned by nobody)
    local current_uid=""
    local current_gid=""
    if [ -r "$share_path" ]; then
      current_uid=$(stat -c "%u" "$share_path" 2>/dev/null || stat -f "%u" "$share_path" 2>/dev/null || echo "")
      current_gid=$(stat -c "%g" "$share_path" 2>/dev/null || stat -f "%g" "$share_path" 2>/dev/null || echo "")
    fi
    
    # Try to set ownership
    if chown "$UID_VALUE:$GID_VALUE" "$share_path" 2>/dev/null; then
      echo "Set ownership of $share_path to $UID_VALUE:$GID_VALUE" >&2
    else
      # If chown failed, it's likely a bind mount - check if permissions are already correct on host
      if [ -n "$current_uid" ] && [ -n "$current_gid" ]; then
        if [ "$current_uid" = "65534" ] || [ "$current_gid" = "65534" ]; then
          echo "Warning: Share path $share_path appears to be a bind mount with incorrect permissions (UID:$current_uid GID:$current_gid)" >&2
          echo "Warning: The directory on the host must have UID $UID_VALUE and GID $GID_VALUE" >&2
          echo "Warning: Ensure the user in the container has UID $UID_VALUE and GID $GID_VALUE" >&2
          echo "Warning: Then set permissions on the host: chown $UID_VALUE:$GID_VALUE <host-path>" >&2
        elif [ "$current_uid" != "$UID_VALUE" ] || [ "$current_gid" != "$GID_VALUE" ]; then
          echo "Warning: Share path $share_path has UID:$current_uid GID:$current_gid, but should be $UID_VALUE:$GID_VALUE" >&2
          echo "Warning: This may be a bind mount. Set permissions on the host: chown $UID_VALUE:$GID_VALUE <host-path>" >&2
        fi
      else
        echo "Warning: Failed to set ownership of $share_path to $UID_VALUE:$GID_VALUE" >&2
        echo "Warning: This may be due to the directory being a bind mount from the host." >&2
      fi
    fi
    
    # Set permissions (rwx for owner, rwx for group, rx for others)
    # Use 775 instead of 755 to allow group write access, which helps with force user
    if chmod 775 "$share_path" 2>/dev/null; then
      echo "Set permissions of $share_path to 775" >&2
    else
      echo "Warning: Failed to set permissions of $share_path. Permissions may be incorrect." >&2
    fi
    
    # Additional check: verify the directory is writable
    # Even with force user, Samba needs the directory to be writable
    if [ ! -w "$share_path" ]; then
      echo "Warning: Share path $share_path is not writable!" >&2
      echo "Warning: Even with 'force user', Samba requires the directory to be writable." >&2
      echo "Warning: This is likely because the directory is a bind mount with incorrect permissions on the host." >&2
      echo "Warning: Fix on host: chown $UID_VALUE:$GID_VALUE <host-path> && chmod 775 <host-path>" >&2
    fi
  else
    echo "Warning: UID/GID not provided. Cannot set permissions on $share_path." >&2
    echo "Warning: Ensure permissions are set correctly, especially for bind mounts from the host." >&2
  fi
  
  # Append share configuration directly to smb.conf
  # Note: force user/group makes Samba run file operations as the specified user
  # This requires the directory to be writable by that user or owned by that user
  
  # Determine guest access for this share
  local guest_ok_share="no"
  local valid_users_line=""
  if [ "$ALLOW_GUEST" = "true" ] || [ "$ALLOW_GUEST" = "1" ]; then
    guest_ok_share="yes"
    # If guest access is allowed, valid users is optional (guest can access)
    valid_users_line=""
  else
    # If guest access is not allowed, require valid user
    valid_users_line="  valid users = $USERNAME"
  fi
  
  cat >> /etc/samba/smb.conf <<EOF
[$share_name]
  path = $share_path
  available = yes
  writable = yes
  guest ok = $guest_ok_share
${valid_users_line}
  vfs objects = catia fruit streams_xattr
  fruit:time machine = yes
  force user = $USERNAME
  force group = $USERNAME
  create mask = 0664
  directory mask = 0775

EOF
  
  echo "Created Samba share '$share_name' at $share_path" >&2
  SHARE_COUNT=$((SHARE_COUNT + 1))
}

# Process all shares (volumes and additional shares)
create_all_shares() {
  # Combine both sources
  local all_shares=""
  if [ -n "$VOLUMES" ]; then
    all_shares="$VOLUMES"
  fi
  if [ -n "$ADDITIONAL_SHARES" ]; then
    if [ -n "$all_shares" ]; then
      all_shares="$all_shares"$'\n'"$ADDITIONAL_SHARES"
    else
      all_shares="$ADDITIONAL_SHARES"
    fi
  fi

  if [ -z "$all_shares" ]; then
    echo "Warning: No Samba shares to create. Provide 'volumes' or 'additional_shares' parameter." >&2
    return
  fi

  # Use a temporary file to avoid subshell issues
  local tmpfile=$(mktemp)
  echo "$all_shares" > "$tmpfile"
  
  while IFS= read -r line <&3; do
    # Skip empty lines
    [ -z "$line" ] && continue
    
    # Parse format: key=value or key=value,permissions (ignore permissions for Samba)
    local share_name=$(echo "$line" | cut -d'=' -f1)
    local share_rest=$(echo "$line" | cut -d'=' -f2-)
    # Extract path (before comma if permissions are present)
    local share_path=$(echo "$share_rest" | cut -d',' -f1)
    
    # Skip if share name or path is empty
    [ -z "$share_name" ] && continue
    [ -z "$share_path" ] && continue
    
    create_share_config "$share_name" "$share_path"
  done 3< "$tmpfile"
  rm -f "$tmpfile"

  if [ "$SHARE_COUNT" -eq 0 ]; then
    echo "Warning: No Samba shares were created. Provide 'volumes' or 'additional_shares' parameter." >&2
  fi
}

# Configure Avahi for macOS Time Machine Bonjour discovery
configure_avahi() {
  local avahi_service_dir="/etc/avahi/services"
  mkdir -p "$avahi_service_dir"

  # Combine all shares for Avahi configuration
  local all_shares=""
  if [ -n "$VOLUMES" ]; then
    all_shares="$VOLUMES"
  fi
  if [ -n "$ADDITIONAL_SHARES" ]; then
    if [ -n "$all_shares" ]; then
      all_shares="$all_shares"$'\n'"$ADDITIONAL_SHARES"
    else
      all_shares="$ADDITIONAL_SHARES"
    fi
  fi

  if [ -z "$all_shares" ]; then
    return
  fi

  # Build Avahi service configuration with all shares
  local avahi_shares=""
  local tmpfile=$(mktemp)
  echo "$all_shares" > "$tmpfile"
  while IFS= read -r line <&3; do
    [ -z "$line" ] && continue
    local share_name=$(echo "$line" | cut -d'=' -f1)
    [ -z "$share_name" ] && continue
    if [ -z "$avahi_shares" ]; then
      avahi_shares="dk0=adVN=$share_name,adVF=0x82"
    else
      # Count existing shares to get next index
      local share_index=$(echo "$avahi_shares" | grep -o "dk[0-9]*" | tail -1 | sed 's/dk//')
      share_index=$((share_index + 1))
      avahi_shares="$avahi_shares"$'\n'"      <txt-record>dk$share_index=adVN=$share_name,adVF=0x82</txt-record>"
    fi
  done 3< "$tmpfile"
  rm -f "$tmpfile"

  if [ -z "$avahi_shares" ]; then
    return
  fi

  # Create Avahi service file
  local first_share=$(echo "$avahi_shares" | head -1)
  local remaining_shares=$(echo "$avahi_shares" | tail -n +2)
  
  cat > "$avahi_service_dir/samba.service" <<EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
   <name replace-wildcards="yes">%h</name>
   <service>
      <type>_smb._tcp</type>
      <port>445</port>
   </service>
   <service>
      <type>_device-info._tcp</type>
      <port>0</port>
      <txt-record>model=RackMac</txt-record>
   </service>
   <service>
      <type>_adisk._tcp</type>
      <txt-record>sys=waMa=0,adVF=0x100</txt-record>
      <txt-record>$first_share</txt-record>
EOF
  
  # Add remaining shares
  if [ -n "$remaining_shares" ]; then
    echo "$remaining_shares" | while IFS= read -r share; do
      echo "      $share" >> "$avahi_service_dir/samba.service"
    done
  fi
  
  cat >> "$avahi_service_dir/samba.service" <<EOF
   </service>
</service-group>
EOF
}

# Start and enable services (DBus, Avahi, Samba)
start_services() {
  # Start DBus (required by Avahi on Alpine)
  if command -v dbus-daemon >/dev/null 2>&1 && [ ! -S /var/run/dbus/system_bus_socket ]; then
    if [ -n "$SERVICE_CMD" ]; then
      $SERVICE_CMD dbus start >/dev/null 2>&1 || true
    fi
  fi

  # Enable and start/restart Avahi (restart to reload service files)
  if [ -n "$SERVICE_CMD" ]; then
    # Enable service (OpenRC uses different syntax)
    if [ "$SERVICE_CMD" = "rc-service" ]; then
      rc-update add avahi-daemon default >/dev/null 2>&1 || true
    else
      $SERVICE_ENABLE_CMD avahi-daemon >/dev/null 2>&1 || true
    fi
    
    # Restart or start service
    $SERVICE_CMD avahi-daemon restart >/dev/null 2>&1 || $SERVICE_CMD avahi-daemon start >/dev/null 2>&1 || true
  fi

  # Verify Avahi is running
  if [ -n "$SERVICE_IS_ACTIVE_CMD" ]; then
    if [ "$SERVICE_CMD" = "systemctl" ]; then
      if ! $SERVICE_IS_ACTIVE_CMD avahi-daemon 2>/dev/null; then
        echo "Warning: Avahi daemon may not be running. Time Machine discovery may not work." >&2
      fi
    else
      # For other service managers, try to check status
      if ! $SERVICE_STATUS_CMD avahi-daemon >/dev/null 2>&1; then
        echo "Warning: Avahi daemon may not be running. Time Machine discovery may not work." >&2
      fi
    fi
  fi

  # Enable and restart Samba
  local samba_service=""
  if [ -n "$SERVICE_CMD" ]; then
    # Determine service name based on OS and service manager
    if [ "$SERVICE_CMD" = "rc-service" ]; then
      # Alpine Linux with OpenRC: service name is "samba"
      samba_service="samba"
    elif [ "$SERVICE_CMD" = "systemctl" ]; then
      # Debian/Ubuntu with systemd: service name is "smbd"
      samba_service="smbd"
    else
      # Fallback: default to "smbd", will try "samba" if that fails
      samba_service="smbd"
    fi
    
    # Enable service (if not already enabled)
    if [ "$SERVICE_CMD" = "rc-service" ]; then
      rc-update add "$samba_service" default >/dev/null 2>&1 || true
    elif [ "$SERVICE_CMD" = "systemctl" ]; then
      $SERVICE_ENABLE_CMD "$samba_service" >/dev/null 2>&1 || true
    fi
    
    # Restart service
    if $SERVICE_CMD restart "$samba_service" 1>&2; then
      return 0
    elif [ "$samba_service" = "smbd" ] && $SERVICE_CMD restart samba 1>&2; then
      # Fallback: try "samba" if "smbd" doesn't work
      return 0
    fi
  fi

  echo "Error: Failed to restart Samba service" >&2
  if [ -n "$samba_service" ]; then
    echo "Tried service name: $samba_service" >&2
  else
    echo "Tried service names: smbd, samba" >&2
  fi
  exit 1
}

# Verify share permissions
verify_share_permissions() {
  # Use provided UID/GID
  if [ -z "$UID_VALUE" ] || [ -z "$GID_VALUE" ] || [ "$UID_VALUE" = "" ] || [ "$GID_VALUE" = "" ]; then
    echo "Warning: UID/GID not provided. Cannot verify permissions." >&2
    return
  fi
  
  local user_uid="$UID_VALUE"
  local user_gid="$GID_VALUE"
  
  # Combine all shares
  local all_shares=""
  if [ -n "$VOLUMES" ]; then
    all_shares="$VOLUMES"
  fi
  if [ -n "$ADDITIONAL_SHARES" ]; then
    if [ -n "$all_shares" ]; then
      all_shares="$all_shares"$'\n'"$ADDITIONAL_SHARES"
    else
      all_shares="$ADDITIONAL_SHARES"
    fi
  fi
  
  if [ -z "$all_shares" ]; then
    return
  fi
  
  # Check permissions for each share
  local tmpfile=$(mktemp)
  echo "$all_shares" > "$tmpfile"
  local permission_issues=0
  
  while IFS= read -r line <&3; do
    [ -z "$line" ] && continue
    local share_path=$(echo "$line" | cut -d'=' -f2-)
    [ -z "$share_path" ] && continue
    
    # Ensure share path starts with /
    if [ "$(echo "$share_path" | cut -c1)" != "/" ]; then
      share_path="/$share_path"
    fi
    
    if [ ! -d "$share_path" ]; then
      continue
    fi
    
    # Check if we can write to the directory
    if [ ! -w "$share_path" ]; then
      echo "Warning: Share path $share_path is not writable by current user" >&2
      permission_issues=$((permission_issues + 1))
    fi
    
    # Check ownership (if possible)
    local path_uid=""
    local path_gid=""
    if [ -r "$share_path" ]; then
      path_uid=$(stat -c "%u" "$share_path" 2>/dev/null || stat -f "%u" "$share_path" 2>/dev/null || echo "")
      path_gid=$(stat -c "%g" "$share_path" 2>/dev/null || stat -f "%g" "$share_path" 2>/dev/null || echo "")
      
      if [ -n "$path_uid" ] && [ -n "$path_gid" ]; then
        if [ "$path_uid" != "$user_uid" ] || [ "$path_gid" != "$user_gid" ]; then
          echo "Warning: Share path $share_path is owned by UID $path_uid:GID $path_gid, but should be $user_uid:$user_gid" >&2
          echo "Warning: This may be a bind mount from the host. Set permissions on the host:" >&2
          echo "Warning:   chown $user_uid:$user_gid <host-path>" >&2
          echo "Warning:   chmod 755 <host-path>" >&2
          permission_issues=$((permission_issues + 1))
        fi
      fi
    fi
  done 3< "$tmpfile"
  rm -f "$tmpfile"
  
  if [ "$permission_issues" -gt 0 ]; then
    echo "Warning: Found $permission_issues permission issue(s) with share paths." >&2
    echo "Warning: If shares are bind mounts from the host (via 160-bind-multiple-volumes-to-lxc)," >&2
    echo "Warning: you may need to set permissions on the host directories:" >&2
    echo "Warning:   chown -R $UID_VALUE:$GID_VALUE <host-base-path>/<hostname>/<volume-key>" >&2
    echo "Warning:   chmod -R 755 <host-base-path>/<hostname>/<volume-key>" >&2
  fi
}

# Verify Samba configuration
verify_configuration() {
  if command -v testparm >/dev/null 2>&1; then
    # Test configuration syntax
    echo "Testing Samba configuration syntax..." >&2
    if ! testparm -s >/dev/null 2>&1; then
      echo "Warning: Samba configuration test failed. Please check the configuration." >&2
      return 1
    fi
    
    # Show loaded shares for debugging
    echo "Verifying loaded shares..." >&2
    local loaded_shares=$(testparm -s 2>/dev/null | grep "^\[" | grep -v "^\[global\]" | sed 's/\[\(.*\)\]/\1/')
    if [ -n "$loaded_shares" ]; then
      echo "Loaded shares:" >&2
      echo "$loaded_shares" | sed 's/^/  /' >&2
    else
      echo "  Warning: No shares found in Samba configuration" >&2
    fi
  fi
  
  # Verify share permissions
  verify_share_permissions
}

# Print summary
print_summary() {
  echo "Successfully configured $SHARE_COUNT Samba share(s)" >&2
  echo "Configuration file: /etc/samba/smb.conf" >&2
  if [ "$SHARE_COUNT" -eq 0 ]; then
    echo "Note: No shares were created. Provide 'volumes' or 'additional_shares' parameter." >&2
  fi
  echo "Note: If macOS Time Machine still shows 'necessary features not supported'," >&2
  echo "      this may be an Alpine Linux compatibility issue. Consider using Debian/Ubuntu." >&2
}

# Main execution
main() {
  # Check that required parameters are not empty
  if [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
    echo "Error: Required parameters (username, password) must be set and not empty!" >&2
    exit 1
  fi
  
  # uid and gid are optional, default to 0 (root) if not provided
  if [ -z "$UID_VALUE" ] || [ "$UID_VALUE" = "" ]; then
    UID_VALUE="0"
  fi
  if [ -z "$GID_VALUE" ] || [ "$GID_VALUE" = "" ]; then
    GID_VALUE="0"
  fi

  detect_service_manager
  check_samba_modules
  setup_samba_user
  configure_global_samba
  create_all_shares
  configure_avahi
  start_services
  verify_configuration
  print_summary
}

# Run main function
main
