#!/bin/sh
# Map input device (keyboard/mouse) to LXC container or VM
#
# This script maps a USB input device (keyboard/mouse) to an LXC container or VM by:
# 1. Validating and parsing USB bus:device parameters
# 2. Finding all associated input event devices (/dev/input/event*)
# 3. Updating container/VM configuration with device mappings
# 4. Creating udev rules for automatic device handling on replug
# 5. Setting proper permissions and ownership
#
# Requires:
#   - usb_bus_device: USB device in format bus:device (required)
#   - uid: Container user ID (optional, default: 1000)
#   - gid: Container group ID (optional, default: 1000)
#   - vm_id: LXC container ID or VM ID (from context)
#
# Library: usb-device-common.sh (automatically prepended)
#
# Output: JSON to stdout (errors to stderr)
exec >&2

# VM type detection and management functions are now in usb-device-common.sh library

# Check required parameters
if [ -z "{{ usb_bus_device }}" ] || [ "{{ usb_bus_device }}" = "" ]; then
  echo "Error: usb_bus_device parameter is required (format: bus:device)" >&2
  exit 1
fi

# Parse USB bus:device using library function
if ! parse_usb_bus_device "{{ usb_bus_device }}"; then
  exit 1
fi

# Get USB bus path using library function
USB_BUS_PATH=$(get_usb_bus_path "$USB_BUS" "$USB_DEVICE")
if [ -z "$USB_BUS_PATH" ] || [ ! -e "$USB_BUS_PATH" ]; then
  echo "Error: USB bus path $USB_BUS_PATH does not exist" >&2
  exit 1
fi

# Find input devices associated with this USB bus/device
SYSFS_BASE="/sys/bus/usb/devices"
SYSFS_PATTERN="$USB_BUS-$USB_DEVICE"
INPUT_DEVICES=""

# Search in sysfs for input devices (check base path and all interface paths)
SYSFS_BASE_PATH="$SYSFS_BASE/$SYSFS_PATTERN"
if [ -d "$SYSFS_BASE_PATH" ]; then
  # Check for input/input*/event* pattern
  for INPUT_DIR in "$SYSFS_BASE_PATH"/input/input*/event*; do
    [ ! -d "$INPUT_DIR" ] && continue
    EVENT_NAME=$(basename "$INPUT_DIR")
    if [ -e "/dev/input/$EVENT_NAME" ]; then
      INPUT_DEVICES="$INPUT_DEVICES /dev/input/$EVENT_NAME"
    fi
  done
fi

# Try interface paths if not found
if [ -z "$INPUT_DEVICES" ]; then
  for SYSFS_PATH in $SYSFS_BASE/$SYSFS_PATTERN:*; do
    [ ! -d "$SYSFS_PATH" ] && continue
    for INPUT_DIR in "$SYSFS_PATH"/input/input*/event*; do
      [ ! -d "$INPUT_DIR" ] && continue
      EVENT_NAME=$(basename "$INPUT_DIR")
      if [ -e "/dev/input/$EVENT_NAME" ]; then
        INPUT_DEVICES="$INPUT_DEVICES /dev/input/$EVENT_NAME"
      fi
    done
  done
fi

# Also check /sys/class/input/event* for devices linked to this USB device
if [ -z "$INPUT_DEVICES" ]; then
  for EVENT_DEV in /sys/class/input/event*; do
    [ ! -e "$EVENT_DEV/device" ] && continue
    EVENT_NAME=$(basename "$EVENT_DEV")
    # Check if this event device is linked to our USB device by checking sysfs
    # Navigate from /sys/class/input/eventX/device to find USB device
    if find_vendor_product_from_class_device "input" "$EVENT_NAME"; then
      # Check if vendor/product matches our USB device
      SYSFS_PATH=$(find_usb_sysfs_path "$USB_BUS" "$USB_DEVICE")
      if [ -n "$SYSFS_PATH" ]; then
        SYSFS_VENDOR=$(cat "$SYSFS_PATH/idVendor" 2>/dev/null | tr -d '\n\r' | tr '[:upper:]' '[:lower:]' || echo "")
        SYSFS_PRODUCT=$(cat "$SYSFS_PATH/idProduct" 2>/dev/null | tr -d '\n\r' | tr '[:upper:]' '[:lower:]' || echo "")
        # Normalize VENDOR_ID and PRODUCT_ID to lowercase for comparison
        VENDOR_ID_NORM=$(echo "$VENDOR_ID" | tr '[:upper:]' '[:lower:]')
        PRODUCT_ID_NORM=$(echo "$PRODUCT_ID" | tr '[:upper:]' '[:lower:]')
        if [ "$SYSFS_VENDOR" = "$VENDOR_ID_NORM" ] && [ "$SYSFS_PRODUCT" = "$PRODUCT_ID_NORM" ]; then
          if [ -e "/dev/input/$EVENT_NAME" ]; then
            INPUT_DEVICES="$INPUT_DEVICES /dev/input/$EVENT_NAME"
          fi
        fi
      fi
    fi
  done
fi

if [ -z "$INPUT_DEVICES" ]; then
  echo "Error: Could not find input device for USB bus $USB_BUS device $USB_DEVICE" >&2
  exit 1
fi

# Get container UID/GID (default 1000) - only used for LXC
UID_VALUE="{{ uid }}"
GID_VALUE="{{ gid }}"
CONTAINER_UID="${UID_VALUE:-0}"
CONTAINER_GID="${GID_VALUE:-0}"

# Detect VM type
VM_ID="{{ vm_id }}"
VM_TYPE=$(detect_vm_type "$VM_ID")
if [ "$VM_TYPE" = "unknown" ]; then
  echo "Error: VM/Container $VM_ID does not exist (neither LXC nor QEMU)" >&2
  exit 1
fi

# Set config file based on VM type
if [ "$VM_TYPE" = "lxc" ]; then
  CONFIG_FILE="/etc/pve/lxc/${VM_ID}.conf"
elif [ "$VM_TYPE" = "qemu" ]; then
  CONFIG_FILE="/etc/pve/qemu-server/${VM_ID}.conf"
fi

# Check VM/container is stopped
if ! check_vm_stopped "$VM_ID" "$VM_TYPE"; then
  if [ "$VM_TYPE" = "lxc" ]; then
    echo "Error: Container $VM_ID is running. Please stop it before mapping devices." >&2
  else
    echo "Error: VM $VM_ID is running. Please stop it before mapping devices." >&2
  fi
  exit 1
fi

# Map devices based on VM type
if [ "$VM_TYPE" = "lxc" ]; then
  # LXC: Use devX: entries
  # Remove existing devX: entries (but keep other entries)
  sed -i '/^dev[0-9]*:/d' "$CONFIG_FILE"
  
  # Map each input device
  for DEVICE in $INPUT_DEVICES; do
    DEV_INDEX=$(get_next_dev_index "$CONFIG_FILE")
    add_cgroup_allow "$CONFIG_FILE" "$DEVICE"
    echo "$DEV_INDEX: $DEVICE,uid=$CONTAINER_UID,gid=$CONTAINER_GID,mode=0666" >> "$CONFIG_FILE"
  done
  
  # Map USB bus device using library function (once)
  map_usb_bus_device "$CONFIG_FILE" "$USB_BUS_PATH" "$CONTAINER_UID" "$CONTAINER_GID"
elif [ "$VM_TYPE" = "qemu" ]; then
  # QEMU: Use hostpciX: entries with USB vendor/product ID
  # Get vendor/product ID
  SYSFS_PATH=$(find_usb_sysfs_path "$USB_BUS" "$USB_DEVICE")
  if [ -z "$SYSFS_PATH" ] || ! get_vendor_product_id "$SYSFS_PATH"; then
    echo "Error: Could not determine vendor/product ID for USB device" >&2
    exit 1
  fi
  
  # Remove existing hostpci entries for this vendor/product
  sed -i "/^hostpci[0-9]*:.*${VENDOR_ID}:${PRODUCT_ID}/d" "$CONFIG_FILE"
  
  # Find next free hostpci slot
  HOSTPCI_SLOT=$(get_next_hostpci_slot "$CONFIG_FILE")
  
  # Add hostpci entry with USB vendor/product ID
  # Format: hostpciX: <vendor_id>:<product_id>,usb3=1
  echo "hostpci${HOSTPCI_SLOT}: ${VENDOR_ID}:${PRODUCT_ID},usb3=1" >> "$CONFIG_FILE"
  echo "Mapped USB device (vendor: $VENDOR_ID, product: $PRODUCT_ID) to VM as hostpci${HOSTPCI_SLOT}" >&2
fi

# Set permissions and create udev rules (only for LXC, VMs use hostpci passthrough)
if [ "$VM_TYPE" = "lxc" ]; then
  # Set permissions for all devices using library function
  for DEVICE in $INPUT_DEVICES; do
    set_device_permissions "$DEVICE" "$CONTAINER_UID" "$CONTAINER_GID" "0666"
  done
  set_device_permissions "$USB_BUS_PATH" "$CONTAINER_UID" "$CONTAINER_GID" "0664"
  
  # Create udev rule using library function
  if command -v udevadm >/dev/null 2>&1; then
    SYSFS_PATH=$(find_usb_sysfs_path "$USB_BUS" "$USB_DEVICE")
    if [ -n "$SYSFS_PATH" ] && get_vendor_product_id "$SYSFS_PATH"; then
      # Use mapped values from template if provided, otherwise calculate
      MAPPED_UID="{{ mapped_uid }}"
      MAPPED_GID="{{ mapped_gid }}"
      if [ -z "$MAPPED_UID" ] || [ "$MAPPED_UID" = "" ]; then
        MAPPED_UID=$((CONTAINER_UID + 100000))
      fi
      if [ -z "$MAPPED_GID" ] || [ "$MAPPED_GID" = "" ]; then
        MAPPED_GID=$((CONTAINER_GID + 100000))
      fi
      RULE_FILE="/etc/udev/rules.d/99-lxc-input-${VM_ID}-${VENDOR_ID}-${PRODUCT_ID}.rules"
      
      # Install replug handler script (must be done before setup_udev_rule_with_replug)
      REPLUG_SCRIPT="/usr/local/bin/map-input-device-replug.sh"
      if ! install_replug_handler "$REPLUG_SCRIPT" "$REPLUG_SCRIPT_CONTENT_INPUT"; then
        echo "Error: Failed to install replug handler script" >&2
        return 1
      fi
      
      # Setup udev rule with replug handler using library function
      if ! setup_udev_rule_with_replug "$RULE_FILE" "$VENDOR_ID" "$PRODUCT_ID" "input" "$MAPPED_UID" "$MAPPED_GID" "0666" "$REPLUG_SCRIPT" "${VM_ID}" "$CONTAINER_UID" "$CONTAINER_GID"; then
        echo "Error: Failed to setup udev rule with replug handler" >&2
        exit 1
      fi
    fi
  fi
fi

exit 0

# Store replug script content in variable (used by setup_udev_rules)
# Use quoted heredoc to prevent variable expansion in main script
REPLUG_SCRIPT_CONTENT_INPUT=$(cat <<'REPLUG_SCRIPT_EOF'
#!/bin/sh
# Replug handler for input device mapping
# Called by udev when USB input device is plugged in
# Updates LXC container mapping for all input devices
exec >&2

# Function to update LXC config for input device mapping
# Parameters: config_file, input_devices (space-separated), container_uid, container_gid, usb_bus_path
update_lxc_config_for_input_devices() {
  CONFIG_FILE="\$1"
  INPUT_DEVICES="\$2"
  CONTAINER_UID="\$3"
  CONTAINER_GID="\$4"
  USB_BUS_PATH="\$5"
  
  if [ -z "\$CONFIG_FILE" ] || [ -z "\$INPUT_DEVICES" ]; then
    echo "Error: update_lxc_config_for_input_devices requires config_file and input_devices" >&2
    return 1
  fi
  
  # Remove existing devX: entries
  sed -i '/^dev[0-9]*:/d' "\$CONFIG_FILE"
  
  # Remove old USB bus mount entries
  sed -i "/lxc.mount.entry.*dev\/bus\/usb/d" "\$CONFIG_FILE"
  
  # Remove old cgroup allow entries for input devices
  sed -i "/^lxc.cgroup2.devices.allow = c.*input/d" "\$CONFIG_FILE"
  
  # Add each input device
  for DEVICE in \$INPUT_DEVICES; do
    # Add cgroup allow for the device
    STAT_OUTPUT=\$(stat -c "%t %T" "\$DEVICE" 2>/dev/null || echo "")
    if [ -n "\$STAT_OUTPUT" ]; then
      MAJOR=\$((0x\$(echo "\$STAT_OUTPUT" | cut -d" " -f1)))
      MINOR=\$((0x\$(echo "\$STAT_OUTPUT" | cut -d" " -f2)))
      # Remove old cgroup allow entry
      sed -i "/^lxc.cgroup2.devices.allow = c \$MAJOR:\$MINOR/d" "\$CONFIG_FILE"
      # Add new cgroup allow entry
      echo "lxc.cgroup2.devices.allow = c \$MAJOR:\$MINOR rwm" >> "\$CONFIG_FILE"
    fi
    
    # Find next free dev index
    USED=\$(grep '^dev' "\$CONFIG_FILE" | cut -d: -f1 | sed 's/dev//' || echo "")
    DEV_INDEX=""
    for i in 0 1 2 3 4 5 6 7 8 9; do
      if ! echo "\$USED" | grep -qw "\$i"; then
        DEV_INDEX="dev\$i"
        break
      fi
    done
    if [ -z "\$DEV_INDEX" ]; then
      DEV_INDEX="dev9"  # Fallback
    fi
    
    # Add devX mapping
    echo "\$DEV_INDEX: \$DEVICE,uid=\$CONTAINER_UID,gid=\$CONTAINER_GID,mode=0666" >> "\$CONFIG_FILE"
  done
  
  # Add USB bus device mapping if provided
  if [ -n "\$USB_BUS_PATH" ] && [ -e "\$USB_BUS_PATH" ]; then
    # Add cgroup allow for USB bus device
    STAT_OUTPUT=\$(stat -c "%t %T" "\$USB_BUS_PATH" 2>/dev/null || echo "")
    if [ -n "\$STAT_OUTPUT" ]; then
      MAJOR=\$((0x\$(echo "\$STAT_OUTPUT" | cut -d" " -f1)))
      MINOR=\$((0x\$(echo "\$STAT_OUTPUT" | cut -d" " -f2)))
      sed -i "/^lxc.cgroup2.devices.allow = c \$MAJOR:\$MINOR/d" "\$CONFIG_FILE"
      echo "lxc.cgroup2.devices.allow = c \$MAJOR:\$MINOR rwm" >> "\$CONFIG_FILE"
    fi
    
    # Calculate relative path (without leading /)
    USB_BUS_RELATIVE=\$(echo "\$USB_BUS_PATH" | sed 's|^/||')
    # Add mount entry
    echo "lxc.mount.entry = \$USB_BUS_PATH \$USB_BUS_RELATIVE none bind,optional,create=file,uid=\$CONTAINER_UID,gid=\$CONTAINER_GID,mode=0664" >> "\$CONFIG_FILE"
  fi
}

# Parameters passed from udev rule
VM_ID="\$1"
VENDOR_ID="\$2"
PRODUCT_ID="\$3"
CONTAINER_UID="\$4"
CONTAINER_GID="\$5"

# Debug output
echo "Debug: Replug script called with parameters:" >&2
echo "  VM_ID=\$VM_ID" >&2
echo "  VENDOR_ID=\$VENDOR_ID" >&2
echo "  PRODUCT_ID=\$PRODUCT_ID" >&2
echo "  CONTAINER_UID=\$CONTAINER_UID" >&2
echo "  CONTAINER_GID=\$CONTAINER_GID" >&2

if [ -z "\$VM_ID" ] || [ -z "\$VENDOR_ID" ] || [ -z "\$PRODUCT_ID" ]; then
  echo "Error: Missing parameters (vm_id, vendor_id, product_id)" >&2
  exit 1
fi

# Use defaults if not provided or if set to "NOT_DEFINED"
if [ -z "\$CONTAINER_UID" ] || [ "\$CONTAINER_UID" = "NOT_DEFINED" ]; then
  CONTAINER_UID="1000"
fi
if [ -z "\$CONTAINER_GID" ] || [ "\$CONTAINER_GID" = "NOT_DEFINED" ]; then
  CONTAINER_GID="1000"
fi

# Find the device by vendor/product ID
# We need to find the current bus:device for this vendor/product
SYSFS_BASE="/sys/bus/usb/devices"
INPUT_DEVICES=""
USB_BUS_PATH=""
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
    
    # Get USB bus path
    if [ -n "\$USB_BUS" ] && [ -n "\$USB_DEVICE" ]; then
      USB_BUS_FORMATTED=\$(printf "%03d" "\$USB_BUS")
      USB_DEVICE_FORMATTED=\$(printf "%03d" "\$USB_DEVICE")
      USB_BUS_PATH="/dev/bus/usb/\$USB_BUS_FORMATTED/\$USB_DEVICE_FORMATTED"
    fi
    
    # Find input devices
    SYSFS_PATTERN="\$USB_BUS-\$USB_DEVICE"
    SYSFS_BASE_PATH="\$SYSFS_BASE/\$SYSFS_PATTERN"
    
    # Search in base path
    if [ -d "\$SYSFS_BASE_PATH" ]; then
      for INPUT_DIR in "\$SYSFS_BASE_PATH"/input/input*/event*; do
        [ ! -d "\$INPUT_DIR" ] && continue
        EVENT_NAME=\$(basename "\$INPUT_DIR")
        if [ -e "/dev/input/\$EVENT_NAME" ]; then
          INPUT_DEVICES="\$INPUT_DEVICES /dev/input/\$EVENT_NAME"
        fi
      done
    fi
    
    # Try interface paths if not found
    if [ -z "\$INPUT_DEVICES" ]; then
      for SYSFS_PATH in \$SYSFS_BASE/\$SYSFS_PATTERN:*; do
        [ ! -d "\$SYSFS_PATH" ] && continue
        for INPUT_DIR in "\$SYSFS_PATH"/input/input*/event*; do
          [ ! -d "\$INPUT_DIR" ] && continue
          EVENT_NAME=\$(basename "\$INPUT_DIR")
          if [ -e "/dev/input/\$EVENT_NAME" ]; then
            INPUT_DEVICES="\$INPUT_DEVICES /dev/input/\$EVENT_NAME"
          fi
        done
      done
    fi
    
    if [ -n "\$INPUT_DEVICES" ]; then
      break
    fi
  fi
done

if [ -z "\$INPUT_DEVICES" ]; then
  echo "Error: Device not found yet, may need to wait" >&2
  exit 1
fi

# Validate required parameters before proceeding
if [ -z "\$VM_ID" ]; then
  echo "Error: VM_ID is empty" >&2
  exit 1
fi

if [ -z "\$CONTAINER_UID" ] || [ -z "\$CONTAINER_GID" ]; then
  echo "Error: CONTAINER_UID or CONTAINER_GID is empty" >&2
  exit 1
fi

LXC_CONFIG_FILE="/etc/pve/lxc/\${VM_ID}.conf"

# Validate that config file path is valid
if [ -z "\$LXC_CONFIG_FILE" ]; then
  echo "Error: LXC_CONFIG_FILE is empty" >&2
  exit 1
fi

# Update LXC config for input device mapping
if ! update_lxc_config_for_input_devices "\$LXC_CONFIG_FILE" "\$INPUT_DEVICES" "\$CONTAINER_UID" "\$CONTAINER_GID" "\$USB_BUS_PATH"; then
  echo "Error: Failed to update LXC config for input devices" >&2
  exit 1
fi

# Set permissions for all devices
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"
if [ -z "\$MAPPED_UID" ] || [ "\$MAPPED_UID" = "" ]; then
  MAPPED_UID=\$((CONTAINER_UID + 100000))
fi
if [ -z "\$MAPPED_GID" ] || [ "\$MAPPED_GID" = "" ]; then
  MAPPED_GID=\$((CONTAINER_GID + 100000))
fi
for DEVICE in \$INPUT_DEVICES; do
  if ! chown "\$MAPPED_UID:\$MAPPED_GID" "\$DEVICE" 2>/dev/null; then
    echo "Warning: Failed to set ownership of \$DEVICE" >&2
  fi
  if ! chmod 666 "\$DEVICE" 2>/dev/null; then
    echo "Warning: Failed to set permissions of \$DEVICE" >&2
  fi
done

if [ -n "\$USB_BUS_PATH" ] && [ -e "\$USB_BUS_PATH" ]; then
  if ! chown "\$MAPPED_UID:\$MAPPED_GID" "\$USB_BUS_PATH" 2>/dev/null; then
    echo "Warning: Failed to set ownership of \$USB_BUS_PATH" >&2
  fi
  if ! chmod 664 "\$USB_BUS_PATH" 2>/dev/null; then
    echo "Warning: Failed to set permissions of \$USB_BUS_PATH" >&2
  fi
fi

exit 0
REPLUG_SCRIPT_EOF
)

