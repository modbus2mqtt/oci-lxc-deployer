#!/bin/sh
# Map serial device to LXC container
# Requires: usb_bus_device in format bus:device
# Library: usb-device-common.sh (automatically prepended)
exec >&2

# Store function definition in variable for use in main script and replug script
UPDATE_LXC_CONFIG_FUNCTION=$(cat <<'FUNCTION_EOF'
# Function to update LXC config for serial device mapping
# Parameters: config_file, host_device, container_uid, container_gid
update_lxc_config_for_serial_device() {
  CONFIG_FILE="$1"
  HOST_DEVICE="$2"
  CONTAINER_UID="$3"
  CONTAINER_GID="$4"
  
  if [ -z "$CONFIG_FILE" ] || [ -z "$HOST_DEVICE" ]; then
    echo "Error: update_lxc_config_for_serial_device requires config_file and host_device" >&2
    return 1
  fi
  
  # Remove existing dev0 entry
  sed -i '/^dev0:/d' "$CONFIG_FILE"
  
  # Add cgroup allow for the device
  STAT_OUTPUT=$(stat -c "%t %T" "$HOST_DEVICE" 2>/dev/null || echo "")
  if [ -n "$STAT_OUTPUT" ]; then
    MAJOR=$((0x$(echo "$STAT_OUTPUT" | awk '{print $1}')))
    MINOR=$((0x$(echo "$STAT_OUTPUT" | awk '{print $2}')))
    # Remove old cgroup allow entry
    sed -i "/^lxc.cgroup2.devices.allow = c $MAJOR:$MINOR/d" "$CONFIG_FILE"
    # Add new cgroup allow entry
    echo "lxc.cgroup2.devices.allow = c $MAJOR:$MINOR rwm" >> "$CONFIG_FILE"
  fi
  
  # Add dev0 mapping (without mp=, as it's not supported)
  echo "dev0: $HOST_DEVICE,uid=$CONTAINER_UID,gid=$CONTAINER_GID,mode=0664" >> "$CONFIG_FILE"
}
FUNCTION_EOF
)

# Define function in main script from variable
eval "$UPDATE_LXC_CONFIG_FUNCTION"

# Store replug script content in variable (used by setup_udev_rules)
# Use quoted heredoc to prevent variable expansion in main script
REPLUG_SCRIPT_CONTENT_SERIAL=$(cat <<'REPLUG_SCRIPT_EOF'
#!/bin/sh
# Replug handler for serial device mapping
# Called by udev when USB serial device is plugged in
# Updates LXC container mapping and creates symlink in container
exec >&2

# Function to update LXC config for serial device mapping
# Parameters: config_file, host_device, container_uid, container_gid
update_lxc_config_for_serial_device() {
  CONFIG_FILE="\$1"
  HOST_DEVICE="\$2"
  CONTAINER_UID="\$3"
  CONTAINER_GID="\$4"
  
  if [ -z "\$CONFIG_FILE" ] || [ -z "\$HOST_DEVICE" ]; then
    echo "Error: update_lxc_config_for_serial_device requires config_file and host_device" >&2
    return 1
  fi
  
  # Remove existing dev0 entry
  sed -i '/^dev0:/d' "\$CONFIG_FILE"
  
  # Add cgroup allow for the device
  STAT_OUTPUT=\$(stat -c "%t %T" "\$HOST_DEVICE" 2>/dev/null || echo "")
  if [ -n "\$STAT_OUTPUT" ]; then
    MAJOR=\$((0x\$(echo "\$STAT_OUTPUT" | cut -d" " -f1)))
    MINOR=\$((0x\$(echo "\$STAT_OUTPUT" | cut -d" " -f2)))
    # Remove old cgroup allow entry
    sed -i "/^lxc.cgroup2.devices.allow = c \$MAJOR:\$MINOR/d" "\$CONFIG_FILE"
    # Add new cgroup allow entry
    echo "lxc.cgroup2.devices.allow = c \$MAJOR:\$MINOR rwm" >> "\$CONFIG_FILE"
  fi
  
  # Add dev0 mapping (without mp=, as it's not supported)
  echo "dev0: \$HOST_DEVICE,uid=\$CONTAINER_UID,gid=\$CONTAINER_GID,mode=0664" >> "\$CONFIG_FILE"
}

# Parameters passed from udev rule
VM_ID="\$1"
VENDOR_ID="\$2"
PRODUCT_ID="\$3"
CONTAINER_DEVICE_PATH="\$4"
CONTAINER_UID="\$5"
CONTAINER_GID="\$6"

# Debug output
echo "Debug: Replug script called with parameters:" >&2
echo "  VM_ID=$VM_ID" >&2
echo "  VENDOR_ID=$VENDOR_ID" >&2
echo "  PRODUCT_ID=$PRODUCT_ID" >&2
echo "  CONTAINER_DEVICE_PATH=$CONTAINER_DEVICE_PATH" >&2
echo "  CONTAINER_UID=$CONTAINER_UID" >&2
echo "  CONTAINER_GID=$CONTAINER_GID" >&2

if [ -z "$VM_ID" ] || [ -z "$VENDOR_ID" ] || [ -z "$PRODUCT_ID" ]; then
  echo "Error: Missing parameters (vm_id, vendor_id, product_id)" >&2
  exit 1
fi

# Use defaults if not provided or if set to "NOT_DEFINED"
if [ -z "$CONTAINER_DEVICE_PATH" ] || [ "$CONTAINER_DEVICE_PATH" = "NOT_DEFINED" ]; then
  CONTAINER_DEVICE_PATH="/dev/ttyUSB0"
fi
if [ -z "$CONTAINER_UID" ] || [ "$CONTAINER_UID" = "NOT_DEFINED" ]; then
  CONTAINER_UID="1000"
fi
if [ -z "$CONTAINER_GID" ] || [ "$CONTAINER_GID" = "NOT_DEFINED" ]; then
  CONTAINER_GID="1000"
fi

# Find the device by vendor/product ID
# We need to find the current bus:device for this vendor/product
SYSFS_BASE="/sys/bus/usb/devices"
ACTUAL_HOST_DEVICE=""
USB_BUS=""
USB_DEVICE=""

for USB_DEVICE_PATH in \$SYSFS_BASE/*; do
  [ ! -d "\$USB_DEVICE_PATH" ] && continue
  
  DEV_VENDOR=\$(cat "\$USB_DEVICE_PATH/idVendor" 2>/dev/null | tr -d '\n\r' | tr '[:upper:]' '[:lower:]' || echo "")
  DEV_PRODUCT=\$(cat "\$USB_DEVICE_PATH/idProduct" 2>/dev/null | tr -d '\n\r' | tr '[:upper:]' '[:lower:]' || echo "")
  
  # Normalize VENDOR_ID and PRODUCT_ID to lowercase for comparison
  VENDOR_ID_NORM=\$(echo "\$VENDOR_ID" | tr '[:upper:]' '[:lower:]')
  PRODUCT_ID_NORM=\$(echo "\$PRODUCT_ID" | tr '[:upper:]' '[:lower:]')
  
  if [ "\$DEV_VENDOR" = "\$VENDOR_ID_NORM" ] && [ "\$DEV_PRODUCT" = "\$PRODUCT_ID_NORM" ]; then
    # Found matching USB device, extract bus/device
    DEVICE_BASENAME=\$(basename "\$USB_DEVICE_PATH")
    USB_BUS=\$(echo "\$DEVICE_BASENAME" | sed -n 's/^\([0-9]*\)-.*/\1/p' | sed 's/^0*//' || echo "")
    USB_DEVICE=\$(echo "\$DEVICE_BASENAME" | sed -n 's/^[0-9]*-\([0-9]*\)[.:].*/\1/p' | sed 's/^0*//' || echo "")
    if [ -z "\$USB_DEVICE" ]; then
      USB_DEVICE=\$(echo "\$DEVICE_BASENAME" | sed -n 's/^[0-9]*-\([0-9]*\)$/\1/p' | sed 's/^0*//' || echo "")
    fi
    
    # Find tty device
    SYSFS_PATTERN="\$USB_BUS-\$USB_DEVICE"
    SYSFS_BASE_PATH="\$SYSFS_BASE/\$SYSFS_PATTERN"
    if [ -d "\$SYSFS_BASE_PATH" ]; then
      for TTY_DIR in "\$SYSFS_BASE_PATH"/*/tty* "\$SYSFS_BASE_PATH"/tty*; do
        [ ! -d "\$TTY_DIR" ] && continue
        TTY_NAME=\$(basename "\$TTY_DIR")
        if [ -e "/dev/\$TTY_NAME" ]; then
          ACTUAL_HOST_DEVICE="/dev/\$TTY_NAME"
          break
        fi
      done
    fi
    
    if [ -z "\$ACTUAL_HOST_DEVICE" ]; then
      for SYSFS_PATH in \$SYSFS_BASE/\$SYSFS_PATTERN:*; do
        [ ! -d "\$SYSFS_PATH" ] && continue
        for TTY_DIR in "\$SYSFS_PATH"/*/tty* "\$SYSFS_PATH"/tty*; do
          [ ! -d "\$TTY_DIR" ] && continue
          TTY_NAME=\$(basename "\$TTY_DIR")
          if [ -e "/dev/\$TTY_NAME" ]; then
            ACTUAL_HOST_DEVICE="/dev/\$TTY_NAME"
            break 2
          fi
        done
      done
    fi
    
    if [ -n "\$ACTUAL_HOST_DEVICE" ]; then
      break
    fi
  fi
done

if [ -z "\$ACTUAL_HOST_DEVICE" ] || [ ! -e "\$ACTUAL_HOST_DEVICE" ]; then
  echo "Error: Device not found yet, may need to wait" >&2
  echo "Debug: ACTUAL_HOST_DEVICE=\$ACTUAL_HOST_DEVICE" >&2
  exit 1
fi

# Validate required parameters before proceeding
if [ -z "\$VM_ID" ]; then
  echo "Error: VM_ID is empty" >&2
  exit 1
fi

if [ -z "\$CONTAINER_UID" ] || [ -z "\$CONTAINER_GID" ]; then
  echo "Error: CONTAINER_UID or CONTAINER_GID is empty" >&2
  echo "Debug: CONTAINER_UID=\$CONTAINER_UID, CONTAINER_GID=\$CONTAINER_GID" >&2
  exit 1
fi

LXC_CONFIG_FILE="/etc/pve/lxc/\${VM_ID}.conf"

# Validate that config file path is valid
if [ -z "\$LXC_CONFIG_FILE" ]; then
  echo "Error: LXC_CONFIG_FILE is empty" >&2
  exit 1
fi

# Debug output before calling update_lxc_config_for_serial_device
echo "Debug: About to call update_lxc_config_for_serial_device with:" >&2
echo "  LXC_CONFIG_FILE=\$LXC_CONFIG_FILE" >&2
echo "  ACTUAL_HOST_DEVICE=\$ACTUAL_HOST_DEVICE" >&2
echo "  CONTAINER_UID=\$CONTAINER_UID" >&2
echo "  CONTAINER_GID=\$CONTAINER_GID" >&2

# Update LXC config for serial device mapping
if ! update_lxc_config_for_serial_device "\$LXC_CONFIG_FILE" "\$ACTUAL_HOST_DEVICE" "\$CONTAINER_UID" "\$CONTAINER_GID"; then
  echo "Error: Failed to update LXC config for serial device" >&2
  echo "Debug: LXC_CONFIG_FILE=\$LXC_CONFIG_FILE, ACTUAL_HOST_DEVICE=\$ACTUAL_HOST_DEVICE, CONTAINER_UID=\$CONTAINER_UID, CONTAINER_GID=\$CONTAINER_GID" >&2
  exit 1
fi

# Create symlink in container to stable path
# Wait a moment for container to be ready if it's running
if pct status "\$VM_ID" 2>&1 | grep -q 'status: running'; then
  sleep 1
  # Create symlink in container to stable path
  HOST_DEVICE_NAME=\$(basename "\$ACTUAL_HOST_DEVICE")
  
  # Check if CONTAINER_DEVICE_PATH is the same as ACTUAL_HOST_DEVICE (no symlink needed)
  if [ "\$CONTAINER_DEVICE_PATH" = "\$ACTUAL_HOST_DEVICE" ]; then
    echo "Debug: CONTAINER_DEVICE_PATH equals ACTUAL_HOST_DEVICE, skipping symlink creation" >&2
  # Check if CONTAINER_DEVICE_PATH doesn't start with /dev/ (invalid path)
  elif [ "\$(echo "\$CONTAINER_DEVICE_PATH" | cut -c1-5)" != "/dev/" ]; then
    echo "Warning: CONTAINER_DEVICE_PATH does not start with /dev/, skipping symlink creation" >&2
    echo "Debug: CONTAINER_DEVICE_PATH=\$CONTAINER_DEVICE_PATH, ACTUAL_HOST_DEVICE=\$ACTUAL_HOST_DEVICE" >&2
  else
    # Create symlink only if target and source are different
    if ! lxc-attach -n "\$VM_ID" -- sh -c "ln -sf /dev/\$HOST_DEVICE_NAME \$CONTAINER_DEVICE_PATH 2>/dev/null" 2>&1; then
      echo "Warning: Failed to create symlink in container" >&2
    fi
  fi
fi

# Set permissions
MAPPED_UID=\$((CONTAINER_UID + 100000))
MAPPED_GID=\$((CONTAINER_GID + 100000))
if ! chown "\$MAPPED_UID:\$MAPPED_GID" "\$ACTUAL_HOST_DEVICE" 2>/dev/null; then
  echo "Error: Failed to set ownership of \$ACTUAL_HOST_DEVICE" >&2
  exit 1
fi
if ! chmod 664 "\$ACTUAL_HOST_DEVICE" 2>/dev/null; then
  echo "Error: Failed to set permissions of \$ACTUAL_HOST_DEVICE" >&2
  exit 1
fi

exit 0
REPLUG_SCRIPT_EOF
)

# Global variables (shared between functions)
CONTAINER_DEVICE_PATH=""
CONTAINER_UID=""
CONTAINER_GID=""
USB_BUS_PATH=""
ACTUAL_HOST_DEVICE=""
VENDOR_ID=""
PRODUCT_ID=""

# Function to validate and parse input parameters
validate_and_parse_parameters() {
  # Check required parameters
  if [ -z "{{ usb_bus_device }}" ] || [ "{{ usb_bus_device }}" = "" ]; then
    echo "Error: usb_bus_device parameter is required (format: bus:device)" >&2
    return 1
  fi

  # Parse USB bus:device using library function
  if ! parse_usb_bus_device "{{ usb_bus_device }}"; then
    return 1
  fi

  # Get container UID/GID (default 1000)
  UID_VALUE="{{ uid }}"
  GID_VALUE="{{ gid }}"
  CONTAINER_UID="${UID_VALUE:-1000}"
  CONTAINER_GID="${GID_VALUE:-1000}"

  # Determine container device path
  CONTAINER_DEVICE_PATH_PARAM="{{ container_device_path }}"
  if [ -n "$CONTAINER_DEVICE_PATH_PARAM" ] && [ "$CONTAINER_DEVICE_PATH_PARAM" != "" ]; then
    CONTAINER_DEVICE_PATH="$CONTAINER_DEVICE_PATH_PARAM"
  else
    # Default to /dev/ttyUSB0 for stability
    CONTAINER_DEVICE_PATH="/dev/ttyUSB0"
  fi

  return 0
}

# Function to find and validate USB devices
find_and_validate_devices() {
  # Get USB bus path using library function
  USB_BUS_PATH=$(get_usb_bus_path "$USB_BUS" "$USB_DEVICE")
  if [ -z "$USB_BUS_PATH" ] || [ ! -e "$USB_BUS_PATH" ]; then
    echo "Error: USB bus path $USB_BUS_PATH does not exist" >&2
    echo "Debug: USB_BUS=$USB_BUS, USB_DEVICE=$USB_DEVICE" >&2
    return 1
  fi

  # Find tty device using library function
  ACTUAL_HOST_DEVICE=$(find_tty_device "$USB_BUS" "$USB_DEVICE")
  if [ -z "$ACTUAL_HOST_DEVICE" ] || [ ! -e "$ACTUAL_HOST_DEVICE" ]; then
    echo "Error: Could not find tty device for USB bus $USB_BUS device $USB_DEVICE" >&2
    return 1
  fi

  return 0
}

# Function to setup LXC container mapping
setup_lxc_mapping() {
  CONFIG_FILE="/etc/pve/lxc/{{ vm_id }}.conf"

  # Check container is stopped using library function
  if ! check_container_stopped "{{ vm_id }}"; then
    echo "Error: Container {{ vm_id }} is running. Please stop it before mapping devices." >&2
    return 1
  fi

  # Remove existing entries (mp0 is legacy, keep for compatibility)
  sed -i '/^mp0:/d' "$CONFIG_FILE"

  # Map USB bus device using library function
  # This is not handled by udev, so must be done here
  map_usb_bus_device "$CONFIG_FILE" "$USB_BUS_PATH" "$CONTAINER_UID" "$CONTAINER_GID"

  return 0
}

# Function to create udev rules and configuration
setup_udev_rules() {
  if ! command -v udevadm >/dev/null 2>&1; then
    echo "Warning: udevadm not found, skipping udev rule creation" >&2
    return 0
  fi

  SYSFS_PATH=$(find_usb_sysfs_path "$USB_BUS" "$USB_DEVICE")
  if [ -z "$SYSFS_PATH" ]; then
    echo "Error: Could not find sysfs path for USB bus $USB_BUS device $USB_DEVICE" >&2
    return 1
  fi

  if ! get_vendor_product_id "$SYSFS_PATH"; then
    echo "Error: Could not determine vendor/product ID from sysfs path $SYSFS_PATH" >&2
    return 1
  fi

  if [ -z "$VENDOR_ID" ] || [ -z "$PRODUCT_ID" ]; then
    echo "Error: VENDOR_ID or PRODUCT_ID is empty after get_vendor_product_id" >&2
    return 1
  fi

  MAPPED_UID=$((CONTAINER_UID + 100000))
  MAPPED_GID=$((CONTAINER_GID + 100000))
  
  # Create config directory
  CONFIG_DIR="/etc/lxc-manager/serial-devices"
  mkdir -p "$CONFIG_DIR"
  
  # Save configuration for replug handler
  CONFIG_FILE="$CONFIG_DIR/{{ vm_id }}-${VENDOR_ID}-${PRODUCT_ID}.conf"
  cat > "$CONFIG_FILE" <<EOF
# LXC Serial Device Mapping Config
# Auto-generated by map-serial-device.sh
VM_ID="{{ vm_id }}"
CONTAINER_DEVICE_PATH="$CONTAINER_DEVICE_PATH"
CONTAINER_UID="$CONTAINER_UID"
CONTAINER_GID="$CONTAINER_GID"
VENDOR_ID="$VENDOR_ID"
PRODUCT_ID="$PRODUCT_ID"
EOF
  
  # Create udev rule for permissions
  RULE_FILE="/etc/udev/rules.d/99-lxc-serial-{{ vm_id }}-${VENDOR_ID}-${PRODUCT_ID}.rules"
  
  # Install replug handler script (must be done before setup_udev_rule_with_replug)
  REPLUG_SCRIPT="/usr/local/bin/map-serial-device-replug.sh"
  if ! install_replug_handler "$REPLUG_SCRIPT" "$REPLUG_SCRIPT_CONTENT_SERIAL"; then
    echo "Error: Failed to install replug handler script" >&2
    return 1
  fi
  
  # Setup udev rule with replug handler using library function
  if ! setup_udev_rule_with_replug "$RULE_FILE" "$VENDOR_ID" "$PRODUCT_ID" "tty" "$MAPPED_UID" "$MAPPED_GID" "0664" "$REPLUG_SCRIPT" "{{ vm_id }}" "$CONTAINER_DEVICE_PATH" "$CONTAINER_UID" "$CONTAINER_GID"; then
    echo "Error: Failed to setup udev rule with replug handler" >&2
    return 1
  fi

  return 0
}

# Function to trigger udev rules and execute replug handler
# Note: This function is now mostly redundant since setup_udev_rule_with_replug
# already handles udev reload/trigger and replug execution. Kept for compatibility.
trigger_udev_and_replug() {
  # setup_udev_rule_with_replug already handles everything, so this is a no-op
  # But we verify the replug script exists for error reporting
  REPLUG_SCRIPT="/usr/local/bin/map-serial-device-replug.sh"
  if [ ! -f "$REPLUG_SCRIPT" ]; then
    echo "Warning: Replug script not found at $REPLUG_SCRIPT" >&2
    return 1
  fi
  return 0
}

# Main execution
main() {
  # Validate and parse parameters
  if ! validate_and_parse_parameters; then
    exit 1
  fi

  # Find and validate devices
  if ! find_and_validate_devices; then
    exit 1
  fi

  # Setup LXC container mapping
  if ! setup_lxc_mapping; then
    exit 1
  fi

  # Setup udev rules and configuration
  # Note: setup_udev_rule_with_replug already handles udev reload/trigger and replug execution
  if ! setup_udev_rules; then
    echo "Error: Failed to setup udev rules" >&2
    exit 1
  fi

  exit 0
}

# Run main function
main
