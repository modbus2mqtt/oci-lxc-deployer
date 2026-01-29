#!/bin/sh
# USB Device Common Library
#
# This library provides common functions for mapping USB devices (tty, input, audio) to LXC containers.
# It contains only function definitions - no direct execution.
#
# Main functions:
#   1. parse_usb_bus_device - Parses bus:device format
#   2. get_usb_bus_path - Gets USB bus path
#   3. find_tty_device - Finds tty device for USB bus/device
#   4. find_usb_sysfs_path - Finds sysfs path for USB device
#   5. get_vendor_product_id - Gets vendor/product IDs from sysfs
#   6. check_container_stopped - Checks if container is stopped
#   7. map_usb_bus_device - Maps USB bus device to container
#   8. create_udev_rule - Creates udev rule for permissions
#   9. setup_udev_rule_with_replug - Creates udev rule with replug handler
#   10. install_replug_handler - Installs replug handler script
#
# This library is automatically prepended to scripts that require USB device mapping functionality.

# 1. parse_usb_bus_device(usb_bus_device)
# Parses bus:device format and sets USB_BUS and USB_DEVICE variables
# Returns: 0 on success, 1 on error
parse_usb_bus_device() {
  USB_BUS_DEVICE="$1"
  if [ -z "$USB_BUS_DEVICE" ] || [ "$USB_BUS_DEVICE" = "" ]; then
    echo "Error: usb_bus_device parameter is required (format: bus:device)" >&2
    return 1
  fi
  
  USB_BUS=$(echo "$USB_BUS_DEVICE" | cut -d':' -f1)
  USB_DEVICE=$(echo "$USB_BUS_DEVICE" | cut -d':' -f2)
  
  if [ -z "$USB_BUS" ] || [ -z "$USB_DEVICE" ]; then
    echo "Error: usb_bus_device must be in format bus:device (e.g., 1:3)" >&2
    return 1
  fi
  
  # Validate numeric
  if ! echo "$USB_BUS" | grep -qE '^[0-9]+$' || ! echo "$USB_DEVICE" | grep -qE '^[0-9]+$'; then
    echo "Error: USB bus and device must be numeric" >&2
    return 1
  fi
  
  return 0
}

# 2. get_usb_bus_path(bus, device)
# Returns formatted USB bus path /dev/bus/usb/XXX/YYY
get_usb_bus_path() {
  BUS="$1"
  DEV="$2"
  BUS_FORMATTED=$(printf "%03d" "$BUS" 2>/dev/null || echo "")
  DEV_FORMATTED=$(printf "%03d" "$DEV" 2>/dev/null || echo "")
  if [ -z "$BUS_FORMATTED" ] || [ -z "$DEV_FORMATTED" ]; then
    echo ""
    return 1
  fi
  echo "/dev/bus/usb/$BUS_FORMATTED/$DEV_FORMATTED"
  return 0
}

# 3. find_usb_sysfs_path(bus, device)
# Finds sysfs path for USB device (base path or interface paths)
# Returns: sysfs path as string, empty on error
find_usb_sysfs_path() {
  BUS="$1"
  DEV="$2"
  SYSFS_BASE="/sys/bus/usb/devices"
  SYSFS_PATTERN="$BUS-$DEV"
  
  # Try base path first
  if [ -d "$SYSFS_BASE/$SYSFS_PATTERN" ]; then
    echo "$SYSFS_BASE/$SYSFS_PATTERN"
    return 0
  fi
  
  # Try interface paths
  for SYSFS_PATH in $SYSFS_BASE/$SYSFS_PATTERN:*; do
    if [ -d "$SYSFS_PATH" ]; then
      echo "$SYSFS_PATH"
      return 0
    fi
  done
  
  return 1
}

# 4. get_vendor_product_id(sysfs_path_or_device)
# Extracts vendor and product ID from sysfs path or device
# Sets VENDOR_ID and PRODUCT_ID variables
# Returns: 0 on success, 1 on error
get_vendor_product_id() {
  SOURCE="$1"
  VENDOR_ID=""
  PRODUCT_ID=""
  
  # Check if source is a sysfs path
  if [ "${SOURCE#/sys/}" != "$SOURCE" ]; then
    # Use --path, but query directly from sysfs files first (most reliable)
    if [ -f "$SOURCE/idVendor" ] && [ -f "$SOURCE/idProduct" ]; then
      VENDOR_ID=$(cat "$SOURCE/idVendor" 2>/dev/null | tr -d '\n\r' | tr '[:upper:]' '[:lower:]' || echo "")
      PRODUCT_ID=$(cat "$SOURCE/idProduct" 2>/dev/null | tr -d '\n\r' | tr '[:upper:]' '[:lower:]' || echo "")
    else
      # Fallback to udevadm, but use --query=property to get device-specific attributes
      VENDOR_ID=$(udevadm info --path="$SOURCE" --query=property 2>/dev/null | grep "^ID_VENDOR_ID=" | cut -d= -f2 | tr '[:upper:]' '[:lower:]' | head -n1 || echo "")
      PRODUCT_ID=$(udevadm info --path="$SOURCE" --query=property 2>/dev/null | grep "^ID_MODEL_ID=" | cut -d= -f2 | tr '[:upper:]' '[:lower:]' | head -n1 || echo "")
      # If that doesn't work, try attribute-walk but only get the first match (device itself)
      if [ -z "$VENDOR_ID" ] || [ -z "$PRODUCT_ID" ]; then
        VENDOR_ID=$(udevadm info --path="$SOURCE" --attribute-walk 2>/dev/null | grep -i "ATTRS{idVendor}" | head -n1 | sed 's/.*=="\([^"]*\)".*/\1/' | tr '[:upper:]' '[:lower:]' || echo "")
        PRODUCT_ID=$(udevadm info --path="$SOURCE" --attribute-walk 2>/dev/null | grep -i "ATTRS{idProduct}" | head -n1 | sed 's/.*=="\([^"]*\)".*/\1/' | tr '[:upper:]' '[:lower:]' || echo "")
      fi
    fi
  else
    # Use --name, query device-specific properties
    VENDOR_ID=$(udevadm info --name="$SOURCE" --query=property 2>/dev/null | grep "^ID_VENDOR_ID=" | cut -d= -f2 | tr '[:upper:]' '[:lower:]' | head -n1 || echo "")
    PRODUCT_ID=$(udevadm info --name="$SOURCE" --query=property 2>/dev/null | grep "^ID_MODEL_ID=" | cut -d= -f2 | tr '[:upper:]' '[:lower:]' | head -n1 || echo "")
    # Fallback to attribute-walk
    if [ -z "$VENDOR_ID" ] || [ -z "$PRODUCT_ID" ]; then
      VENDOR_ID=$(udevadm info --name="$SOURCE" --attribute-walk 2>/dev/null | grep -i "ATTRS{idVendor}" | head -n1 | sed 's/.*=="\([^"]*\)".*/\1/' | tr '[:upper:]' '[:lower:]' || echo "")
      PRODUCT_ID=$(udevadm info --name="$SOURCE" --attribute-walk 2>/dev/null | grep -i "ATTRS{idProduct}" | head -n1 | sed 's/.*=="\([^"]*\)".*/\1/' | tr '[:upper:]' '[:lower:]' || echo "")
    fi
  fi
  
  if [ -z "$VENDOR_ID" ] || [ -z "$PRODUCT_ID" ]; then
    return 1
  fi
  
  return 0
}

# 5. add_cgroup_allow(config_file, device_path)
# Adds lxc.cgroup2.devices.allow entry for device
# Idempotent: checks for existence before adding
add_cgroup_allow() {
  CONFIG_FILE="$1"
  DEVICE="$2"
  
  STAT_OUTPUT=$(stat -c "%t %T" "$DEVICE" 2>/dev/null || echo "")
  [ -z "$STAT_OUTPUT" ] && return 1
  
  MAJOR=$((0x$(echo "$STAT_OUTPUT" | awk '{print $1}')))
  MINOR=$((0x$(echo "$STAT_OUTPUT" | awk '{print $2}')))
  
  if ! grep -q "^lxc.cgroup2.devices.allow = c $MAJOR:$MINOR" "$CONFIG_FILE" 2>/dev/null; then
    echo "lxc.cgroup2.devices.allow = c $MAJOR:$MINOR rwm" >> "$CONFIG_FILE"
  fi
  
  return 0
}

# 6. map_usb_bus_device(config_file, usb_bus_path, container_uid, container_gid)
# Maps USB bus device to container
# Removes old entries before adding new ones
map_usb_bus_device() {
  CONFIG_FILE="$1"
  USB_BUS_PATH="$2"
  CONTAINER_UID="$3"
  CONTAINER_GID="$4"
  
  # Remove old USB bus mount entries
  sed -i "/lxc.mount.entry.*dev\/bus\/usb/d" "$CONFIG_FILE"
  
  # Add cgroup allow for USB bus device
  add_cgroup_allow "$CONFIG_FILE" "$USB_BUS_PATH"
  
  # Calculate relative path (without leading /)
  USB_BUS_RELATIVE=$(echo "$USB_BUS_PATH" | sed 's|^/||')
  
  # Add mount entry
  echo "lxc.mount.entry = $USB_BUS_PATH $USB_BUS_RELATIVE none bind,optional,create=file,uid=$CONTAINER_UID,gid=$CONTAINER_GID,mode=0664" >> "$CONFIG_FILE"
  
  return 0
}

# 7. set_device_permissions(device_path, container_uid, container_gid, mode)
# Sets permissions on host device
# Maps container UID/GID to host UID/GID (container + 100000)
set_device_permissions() {
  DEVICE_PATH="$1"
  CONTAINER_UID="$2"
  CONTAINER_GID="$3"
  MODE="$4"
  
  MAPPED_UID=$((CONTAINER_UID + 100000))
  MAPPED_GID=$((CONTAINER_GID + 100000))
  
  chown "$MAPPED_UID:$MAPPED_GID" "$DEVICE_PATH" 2>/dev/null || true
  chmod "$MODE" "$DEVICE_PATH" 2>/dev/null || true
  
  return 0
}

# 8. create_udev_rule(rule_file, vendor_id, product_id, subsystem, mapped_uid, mapped_gid, mode)
# Creates udev rule for automatic permissions on device reconnect
create_udev_rule() {
  RULE_FILE="$1"
  VENDOR_ID="$2"
  PRODUCT_ID="$3"
  SUBSYSTEM="$4"
  MAPPED_UID="$5"
  MAPPED_GID="$6"
  MODE="$7"
  
  if [ ! -n "$VENDOR_ID" ] || [ ! -n "$PRODUCT_ID" ]; then
    return 1
  fi
  
  # Create rule for the subsystem
  echo "SUBSYSTEM==\"$SUBSYSTEM\", ATTRS{idVendor}==\"$VENDOR_ID\", ATTRS{idProduct}==\"$PRODUCT_ID\", MODE=\"$MODE\", OWNER=\"$MAPPED_UID\", GROUP=\"$MAPPED_GID\"" > "$RULE_FILE"
  
  # Also create rule for USB bus device if subsystem is not usb
  if [ "$SUBSYSTEM" != "usb" ]; then
    echo "SUBSYSTEM==\"usb\", ATTRS{idVendor}==\"$VENDOR_ID\", ATTRS{idProduct}==\"$PRODUCT_ID\", MODE=\"$MODE\", OWNER=\"$MAPPED_UID\", GROUP=\"$MAPPED_GID\"" >> "$RULE_FILE"
  fi
  
  # Note: udevadm reload/trigger should be called by caller if needed
  # This function only creates the rule file
  
  return 0
}

# 9a. setup_udev_rule_with_replug(rule_file, vendor_id, product_id, subsystem, mapped_uid, mapped_gid, mode, replug_script_path, vm_id, replug_params...)
# Creates udev rule, adds ACTION=="add" rule for replug handler, reloads and triggers udev, executes replug script
# Parameters:
#   rule_file: Path to udev rule file
#   vendor_id, product_id: USB device IDs
#   subsystem: udev subsystem (tty, input, sound, etc.)
#   mapped_uid, mapped_gid: Host UID/GID for permissions
#   mode: Device permissions mode
#   replug_script_path: Path to replug handler script (must already be installed)
#   vm_id: VM/Container ID
#   replug_params: Additional parameters to pass to replug script (space-separated, will be quoted)
# Returns: 0 on success, 1 on error
setup_udev_rule_with_replug() {
  RULE_FILE="$1"
  VENDOR_ID="$2"
  PRODUCT_ID="$3"
  SUBSYSTEM="$4"
  MAPPED_UID="$5"
  MAPPED_GID="$6"
  MODE="$7"
  REPLUG_SCRIPT_PATH="$8"
  VM_ID="$9"
  shift 9
  REPLUG_PARAMS="$@"
  
  if [ ! -n "$VENDOR_ID" ] || [ ! -n "$PRODUCT_ID" ] || [ -z "$SUBSYSTEM" ] || [ -z "$RULE_FILE" ] || [ -z "$REPLUG_SCRIPT_PATH" ] || [ -z "$VM_ID" ]; then
    return 1
  fi
  
  # Create base udev rule for permissions
  if ! create_udev_rule "$RULE_FILE" "$VENDOR_ID" "$PRODUCT_ID" "$SUBSYSTEM" "$MAPPED_UID" "$MAPPED_GID" "$MODE"; then
    return 1
  fi
  
  # Build replug script command with parameters (properly quoted)
  REPLUG_CMD="$REPLUG_SCRIPT_PATH \"$VM_ID\" \"$VENDOR_ID\" \"$PRODUCT_ID\""
  for PARAM in $REPLUG_PARAMS; do
    REPLUG_CMD="$REPLUG_CMD \"$PARAM\""
  done
  
  # Add ACTION=="add" rule to trigger replug handler
  cat >> "$RULE_FILE" <<EOF

# Auto-update LXC mapping on replug
SUBSYSTEM=="$SUBSYSTEM", ATTRS{idVendor}=="$VENDOR_ID", ATTRS{idProduct}=="$PRODUCT_ID", ACTION=="add", RUN+="/bin/sh -c 'if [ -f $REPLUG_SCRIPT_PATH ]; then $REPLUG_CMD & fi'"
EOF
  
  # Reload udev rules
  if ! udevadm control --reload-rules >&2; then
    echo "Warning: Failed to reload udev rules" >&2
  fi
  
  # Trigger udev rules for current device
  udevadm trigger --subsystem-match="$SUBSYSTEM" --attr-match=idVendor="$VENDOR_ID" --attr-match=idProduct="$PRODUCT_ID" --action=add >&2 || \
  udevadm trigger --subsystem-match="$SUBSYSTEM" --attr-match=idVendor="$VENDOR_ID" --attr-match=idProduct="$PRODUCT_ID" >&2
  
  # Also trigger for USB subsystem (for permissions)
  udevadm trigger --subsystem-match=usb --attr-match=idVendor="$VENDOR_ID" --attr-match=idProduct="$PRODUCT_ID" >&2
  
  # Execute replug handler directly for already connected device
  # This ensures the LXC config is updated even if udev trigger doesn't work
  if [ -f "$REPLUG_SCRIPT_PATH" ]; then
    if ! "$REPLUG_SCRIPT_PATH" "$VM_ID" "$VENDOR_ID" "$PRODUCT_ID" $REPLUG_PARAMS >&2; then
      echo "Error: Replug handler script failed" >&2
      return 1
    fi
  fi
  
  return 0
}

# 8a. install_replug_handler(replug_script_path, replug_script_content)
# Installs a replug handler script to /usr/local/bin
# Parameters:
#   replug_script_path: Full path to the replug script (e.g., /usr/local/bin/map-serial-device-replug.sh)
#   replug_script_content: The content of the replug script (as a string, typically from a heredoc)
# Returns: 0 on success, 1 on error
install_replug_handler() {
  REPLUG_SCRIPT="$1"
  REPLUG_SCRIPT_CONTENT="$2"
  
  if [ -z "$REPLUG_SCRIPT" ] || [ -z "$REPLUG_SCRIPT_CONTENT" ]; then
    echo "Error: install_replug_handler requires replug_script_path and replug_script_content" >&2
    return 1
  fi
  
  REPLUG_SCRIPT_DIR="/usr/local/bin"
  
  # Create directory if it doesn't exist
  if [ ! -d "$REPLUG_SCRIPT_DIR" ]; then
    mkdir -p "$REPLUG_SCRIPT_DIR" >&2
  fi
  
  # Write replug script content to file
  # The content comes from a quoted heredoc, so escaped backslashes (\$) are stored as literals
  # We need to convert \$ back to $ when writing the file
  # Use printf and sed to unescape $ variables (but preserve other escaped characters)
  printf '%s\n' "$REPLUG_SCRIPT_CONTENT" | sed 's/\\\$/$/g' > "$REPLUG_SCRIPT"
  
  # Make script executable
  chmod +x "$REPLUG_SCRIPT" >&2
  
  # Test syntax of generated script
  if ! sh -n "$REPLUG_SCRIPT" >&2; then
    echo "Error: Generated replug script has syntax errors" >&2
    return 1
  fi
  
  echo "Installed replug handler script at $REPLUG_SCRIPT" >&2
  return 0
}

# 9. detect_vm_type(vm_id)
# Detects if VM ID is LXC container or QEMU VM
# Returns: "lxc", "qemu", or "unknown"
detect_vm_type() {
  VM_ID="$1"
  if [ -f "/etc/pve/lxc/${VM_ID}.conf" ]; then
    echo "lxc"
    return 0
  elif [ -f "/etc/pve/qemu-server/${VM_ID}.conf" ]; then
    echo "qemu"
    return 0
  else
    echo "unknown"
    return 1
  fi
}

# 10. check_vm_stopped(vm_id, vm_type)
# Checks if VM/container is stopped
# Parameters: vm_id, vm_type (lxc or qemu)
# Returns: 1 if running, 0 if stopped
check_vm_stopped() {
  VM_ID="$1"
  VM_TYPE="$2"
  if [ "$VM_TYPE" = "lxc" ]; then
    if pct status "$VM_ID" 2>&1 | grep -q 'status: running'; then
      return 1
    fi
  elif [ "$VM_TYPE" = "qemu" ]; then
    if qm status "$VM_ID" 2>&1 | grep -q 'status: running'; then
      return 1
    fi
  fi
  return 0
}

# 11. check_container_stopped(vm_id)
# Checks if container is stopped (legacy function, use check_vm_stopped instead)
# Returns: 1 if running, 0 if stopped
check_container_stopped() {
  VM_ID="$1"
  if pct status "$VM_ID" 2>&1 | grep -q 'status: running'; then
    return 1
  fi
  return 0
}

# 12. get_next_hostpci_slot(config_file)
# Finds next free hostpci slot for QEMU VM
# Returns: slot number (0, 1, 2, etc.)
get_next_hostpci_slot() {
  CONFIG_FILE="$1"
  NEXT_SLOT=0
  while grep -q "^hostpci${NEXT_SLOT}:" "$CONFIG_FILE" 2>/dev/null; do
    NEXT_SLOT=$((NEXT_SLOT+1))
  done
  echo "$NEXT_SLOT"
}

# 13. get_next_dev_index(config_file)
# Finds next free devX: index in config file
# Returns: dev0, dev1, dev2, etc.
get_next_dev_index() {
  CONFIG_FILE="$1"
  USED=$(pct config "$(basename "$CONFIG_FILE" .conf)" 2>/dev/null | grep '^dev' | cut -d: -f1 | sed 's/dev//' || echo "")
  for i in 0 1 2 3 4 5 6 7 8 9; do
    if ! echo "$USED" | grep -qw "$i"; then
      echo "dev$i"
      return 0
    fi
  done
  echo "dev9"  # Fallback to dev9 if all are used
  return 0
}

# 14. resolve_symlink(symlink_path)
# Resolves symlink to actual path (supports multiple levels)
# Returns: resolved path as string, empty on error
resolve_symlink() {
  SYMLINK_PATH="$1"
  if [ ! -L "$SYMLINK_PATH" ]; then
    echo "$SYMLINK_PATH"
    return 0
  fi
  
  # Try readlink -f first
  if command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
    RESOLVED=$(readlink -f "$SYMLINK_PATH" 2>/dev/null || echo "")
    if [ -n "$RESOLVED" ]; then
      echo "$RESOLVED"
      return 0
    fi
  fi
  
  # Fallback: manual resolution
  CURRENT="$SYMLINK_PATH"
  MAX_LEVELS=10
  LEVEL=0
  
  while [ $LEVEL -lt $MAX_LEVELS ] && [ -L "$CURRENT" ]; do
    TARGET=$(readlink "$CURRENT" 2>/dev/null || echo "")
    [ -z "$TARGET" ] && break
    
    if [ "${TARGET#/}" != "$TARGET" ]; then
      CURRENT="$TARGET"
    else
      CURRENT="$(dirname "$CURRENT")/$TARGET"
    fi
    LEVEL=$((LEVEL + 1))
  done
  
  echo "$CURRENT"
  return 0
}

# 15. find_vendor_product_from_class_device(class_path, device_name)
# Navigates from /sys/class/*/device up to find USB device with idVendor/idProduct
# Sets VENDOR_ID and PRODUCT_ID variables
# Returns: 0 on success, 1 on error
find_vendor_product_from_class_device() {
  CLASS_PATH="$1"
  DEVICE_NAME="$2"
  VENDOR_ID=""
  PRODUCT_ID=""
  
  if [ ! -e "/sys/class/$CLASS_PATH/$DEVICE_NAME/device" ]; then
    return 1
  fi
  
  # Get device link
  if command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
    DEVICE_LINK=$(readlink -f "/sys/class/$CLASS_PATH/$DEVICE_NAME/device" 2>/dev/null || echo "")
  else
    DEVICE_LINK=$(readlink "/sys/class/$CLASS_PATH/$DEVICE_NAME/device" 2>/dev/null || echo "")
    if [ -n "$DEVICE_LINK" ] && [ "${DEVICE_LINK#/}" = "$DEVICE_LINK" ]; then
      DEVICE_LINK="/sys/class/$CLASS_PATH/$DEVICE_NAME/$DEVICE_LINK"
    fi
  fi
  
  if [ -z "$DEVICE_LINK" ]; then
    return 1
  fi
  
  # Navigate up to find idVendor/idProduct
  CURRENT_DIR="$DEVICE_LINK"
  MAX_LEVELS=10
  LEVEL=0
  
  while [ $LEVEL -lt $MAX_LEVELS ]; do
    if [ -f "$CURRENT_DIR/idVendor" ] && [ -f "$CURRENT_DIR/idProduct" ]; then
      VENDOR_ID=$(cat "$CURRENT_DIR/idVendor" 2>/dev/null | tr -d '\n\r' || echo "")
      PRODUCT_ID=$(cat "$CURRENT_DIR/idProduct" 2>/dev/null | tr -d '\n\r' || echo "")
      if [ -n "$VENDOR_ID" ] && [ -n "$PRODUCT_ID" ]; then
        return 0
      fi
    fi
    PARENT_DIR=$(dirname "$CURRENT_DIR" 2>/dev/null || echo "")
    if [ "$PARENT_DIR" = "$CURRENT_DIR" ] || [ "$PARENT_DIR" = "/" ] || [ -z "$PARENT_DIR" ]; then
      break
    fi
    CURRENT_DIR="$PARENT_DIR"
    LEVEL=$((LEVEL + 1))
  done
  
  return 1
}

# 16. find_usb_device_by_vendor_product(vendor_id, product_id, device_name, device_pattern)
# Finds USB device by matching vendor/product ID and device pattern
# Sets USB_BUS and USB_DEVICE variables
# Returns: 0 on success, 1 on error
find_usb_device_by_vendor_product() {
  VENDOR_ID="$1"
  PRODUCT_ID="$2"
  DEVICE_NAME="$3"
  DEVICE_PATTERN="$4"
  USB_BUS=""
  USB_DEVICE=""
  
  SYSFS_BASE="/sys/bus/usb/devices"
  
  for USB_DEVICE_PATH in $SYSFS_BASE/*; do
    [ ! -d "$USB_DEVICE_PATH" ] && continue
    
    # Check vendor/product ID
    DEV_VENDOR=$(cat "$USB_DEVICE_PATH/idVendor" 2>/dev/null | tr -d '\n\r' || echo "")
    DEV_PRODUCT=$(cat "$USB_DEVICE_PATH/idProduct" 2>/dev/null | tr -d '\n\r' || echo "")
    
    if [ "$DEV_VENDOR" != "$VENDOR_ID" ] || [ "$DEV_PRODUCT" != "$PRODUCT_ID" ]; then
      continue
    fi
    
    # Check if device pattern exists in this USB device
    DEVICE_BASENAME=$(basename "$USB_DEVICE_PATH")
    
    # Check base path
    for DEV_DIR in "$USB_DEVICE_PATH"/*/$DEVICE_PATTERN "$USB_DEVICE_PATH"/$DEVICE_PATTERN; do
      [ ! -d "$DEV_DIR" ] && continue
      FOUND_NAME=$(basename "$DEV_DIR")
      if [ "$FOUND_NAME" = "$DEVICE_NAME" ]; then
        extract_bus_device_from_sysfs_path "$DEVICE_BASENAME"
        return 0
      fi
    done
    
    # Check interface paths
    for INTERFACE_PATH in $USB_DEVICE_PATH:*; do
      [ ! -d "$INTERFACE_PATH" ] && continue
      for DEV_DIR in "$INTERFACE_PATH"/*/$DEVICE_PATTERN "$INTERFACE_PATH"/$DEVICE_PATTERN; do
        [ ! -d "$DEV_DIR" ] && continue
        FOUND_NAME=$(basename "$DEV_DIR")
        if [ "$FOUND_NAME" = "$DEVICE_NAME" ]; then
          extract_bus_device_from_sysfs_path "$DEVICE_BASENAME"
          return 0
        fi
      done
    done
  done
  
  return 1
}

# 17. extract_bus_device_from_sysfs_path(sysfs_path)
# Extracts bus and device number from sysfs path name
# Sets USB_BUS and USB_DEVICE variables
# Returns: 0 on success, 1 on error
extract_bus_device_from_sysfs_path() {
  SYSFS_PATH="$1"
  # Get basename if full path
  BASENAME=$(basename "$SYSFS_PATH")
  
  # Extract bus (first number before -)
  USB_BUS=$(echo "$BASENAME" | sed -n 's/^\([0-9]*\)-.*/\1/p' | sed 's/^0*//' || echo "")
  
  # Extract device (second number before : or .)
  USB_DEVICE=$(echo "$BASENAME" | sed -n 's/^[0-9]*-\([0-9]*\)[.:].*/\1/p' | sed 's/^0*//' || echo "")
  
  # If no : or . found, try without suffix
  if [ -z "$USB_DEVICE" ]; then
    USB_DEVICE=$(echo "$BASENAME" | sed -n 's/^[0-9]*-\([0-9]*\)$/\1/p' | sed 's/^0*//' || echo "")
  fi
  
  # Validate numeric
  if [ -z "$USB_BUS" ] || [ -z "$USB_DEVICE" ] || ! echo "$USB_BUS" | grep -qE '^[0-9]+$' || ! echo "$USB_DEVICE" | grep -qE '^[0-9]+$'; then
    return 1
  fi
  
  # Convert to integer (remove leading zeros)
  USB_BUS=$((USB_BUS + 0))
  USB_DEVICE=$((USB_DEVICE + 0))
  
  return 0
}

# 18. get_lsusb_description(bus, device)
# Gets lsusb description for specific bus/device
# Returns: description as string, empty on error
get_lsusb_description() {
  BUS="$1"
  DEV="$2"
  
  # Format with leading zeros
  BUS_FORMATTED=$(printf "%03d" "$BUS" 2>/dev/null || echo "")
  DEV_FORMATTED=$(printf "%03d" "$DEV" 2>/dev/null || echo "")
  
  if [ -z "$BUS_FORMATTED" ] || [ -z "$DEV_FORMATTED" ]; then
    return 1
  fi
  
  # Try to get from lsusb
  LSUSB_LINE=$(lsusb 2>/dev/null | grep "^Bus $BUS_FORMATTED Device $DEV_FORMATTED:" || echo "")
  if [ -n "$LSUSB_LINE" ]; then
    echo "$LSUSB_LINE" | sed 's/^Bus [0-9]* Device [0-9]*: ID //' || echo ""
    return 0
  fi
  
  return 1
}

# 19. format_json_device_entry(name, value, is_first)
# Formats device entry for JSON array
# Returns: JSON string
format_json_device_entry() {
  NAME="$1"
  VALUE="$2"
  IS_FIRST="$3"
  
  # Escape quotes in name
  ESCAPED_NAME=$(echo "$NAME" | sed 's/"/\\"/g')
  
  # Add comma if not first
  if [ "$IS_FIRST" != "true" ] && [ "$IS_FIRST" != "1" ]; then
    printf ','
  fi
  
  printf '{"name":"%s","value":"%s"}' "$ESCAPED_NAME" "$VALUE"
  return 0
}

# 20. find_device_in_usb_interfaces(usb_device_path, device_name, device_pattern)
# Searches for device in base path and all interface paths
# Returns: 0 if found, 1 if not found
find_device_in_usb_interfaces() {
  USB_DEVICE_PATH="$1"
  DEVICE_NAME="$2"
  DEVICE_PATTERN="$3"
  
  # Check base path
  for DEV_DIR in "$USB_DEVICE_PATH"/*/$DEVICE_PATTERN "$USB_DEVICE_PATH"/$DEVICE_PATTERN; do
    [ ! -d "$DEV_DIR" ] && continue
    FOUND_NAME=$(basename "$DEV_DIR")
    if [ "$FOUND_NAME" = "$DEVICE_NAME" ]; then
      return 0
    fi
  done
  
  # Check interface paths
  for INTERFACE_PATH in $USB_DEVICE_PATH:*; do
    [ ! -d "$INTERFACE_PATH" ] && continue
    for DEV_DIR in "$INTERFACE_PATH"/*/$DEVICE_PATTERN "$INTERFACE_PATH"/$DEVICE_PATTERN; do
      [ ! -d "$DEV_DIR" ] && continue
      FOUND_NAME=$(basename "$DEV_DIR")
      if [ "$FOUND_NAME" = "$DEVICE_NAME" ]; then
        return 0
      fi
    done
  done
  
  return 1
}

# 21. find_tty_device(bus, device)
# Finds tty device associated with USB bus/device
# Returns: device path as string (e.g., /dev/ttyUSB0), empty on error
find_tty_device() {
  BUS="$1"
  DEV="$2"
  SYSFS_BASE="/sys/bus/usb/devices"
  SYSFS_PATTERN="$BUS-$DEV"
  ACTUAL_HOST_DEVICE=""
  
  # Search in sysfs for tty devices (check base path and all interface paths)
  SYSFS_BASE_PATH="$SYSFS_BASE/$SYSFS_PATTERN"
  if [ -d "$SYSFS_BASE_PATH" ]; then
    for TTY_DIR in "$SYSFS_BASE_PATH"/*/tty* "$SYSFS_BASE_PATH"/tty*; do
      [ ! -d "$TTY_DIR" ] && continue
      TTY_NAME=$(basename "$TTY_DIR")
      if [ -e "/dev/$TTY_NAME" ]; then
        ACTUAL_HOST_DEVICE="/dev/$TTY_NAME"
        break
      fi
    done
  fi
  
  # Try interface paths if not found
  if [ -z "$ACTUAL_HOST_DEVICE" ]; then
    for SYSFS_PATH in $SYSFS_BASE/$SYSFS_PATTERN:*; do
      [ ! -d "$SYSFS_PATH" ] && continue
      for TTY_DIR in "$SYSFS_PATH"/*/tty* "$SYSFS_PATH"/tty*; do
        [ ! -d "$TTY_DIR" ] && continue
        TTY_NAME=$(basename "$TTY_DIR")
        if [ -e "/dev/$TTY_NAME" ]; then
          ACTUAL_HOST_DEVICE="/dev/$TTY_NAME"
          break 2
        fi
      done
    done
  fi
  
  if [ -n "$ACTUAL_HOST_DEVICE" ] && [ -e "$ACTUAL_HOST_DEVICE" ]; then
    echo "$ACTUAL_HOST_DEVICE"
    return 0
  fi
  
  return 1
}

# 22. is_usb_device_mapped_in_running_containers(bus, device)
# Checks if a USB device (bus:device) is already mapped to any running LXC container
# by checking lxc.mount.entry entries containing /dev/bus/usb/{bus}/{device}
# Returns: 0 (true) if device is mapped, 1 (false) otherwise
is_usb_device_mapped_in_running_containers() {
  local bus="$1"
  local device="$2"
  
  # Format bus and device with leading zeros (e.g., 001, 003)
  local bus_formatted=$(printf "%03d" "$bus" 2>/dev/null || echo "$bus")
  local device_formatted=$(printf "%03d" "$device" 2>/dev/null || echo "$device")
  local usb_bus_path="/dev/bus/usb/${bus_formatted}/${device_formatted}"
  
  # Get list of running container IDs
  local running_containers=$(pct list 2>/dev/null | awk 'NR>1 && $2=="running" {print $1}' || echo "")
  
  if [ -z "$running_containers" ]; then
    return 1  # No running containers
  fi
  
  # Check each running container's config
  for vmid in $running_containers; do
    local config_file="/etc/pve/lxc/${vmid}.conf"
    if [ ! -f "$config_file" ]; then
      continue
    fi
    
    # Check for lxc.mount.entry containing this USB bus path
    if grep -q "^lxc.mount.entry.*${usb_bus_path}" "$config_file" 2>/dev/null; then
      return 0  # Device is mapped
    fi
  done
  
  return 1  # Device is not mapped
}