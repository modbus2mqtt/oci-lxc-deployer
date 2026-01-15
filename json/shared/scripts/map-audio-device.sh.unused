#!/bin/sh
# Map audio device to LXC container or VM
#
# This script maps an audio device (ALSA sound card) to an LXC container or VM by:
# 1. Validating and parsing audio card parameter
# 2. Finding all associated audio devices (control, PCM, timer)
# 3. Updating container/VM configuration with device mappings
# 4. Setting proper permissions and ownership
#
# Requires:
#   - audio_card: Audio card identifier in format card0, card1, etc. (required)
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
if [ -z "{{ audio_card }}" ] || [ "{{ audio_card }}" = "" ]; then
  echo "Error: audio_card parameter is required (format: card0, card1, etc.)" >&2
  exit 1
fi

# Extract card number from audio_card parameter
AUDIO_CARD="{{ audio_card }}"
CARD_NUMBER=$(echo "$AUDIO_CARD" | sed 's/card//')

# Validate card number
if [ -z "$CARD_NUMBER" ] || ! echo "$CARD_NUMBER" | grep -qE '^[0-9]+$'; then
  echo "Error: Invalid audio_card format. Expected format: card0, card1, etc." >&2
  exit 1
fi

# Verify card exists
if [ ! -e "/sys/class/sound/$AUDIO_CARD" ]; then
  echo "Error: Audio card $AUDIO_CARD does not exist" >&2
  exit 1
fi

# Find all audio devices for this card
AUDIO_DEVICES=""
# Control device
if [ -e "/dev/snd/controlC$CARD_NUMBER" ]; then
  AUDIO_DEVICES="$AUDIO_DEVICES /dev/snd/controlC$CARD_NUMBER"
fi
# PCM devices (playback and capture)
for PCM_DEV in /dev/snd/pcmC${CARD_NUMBER}D*p /dev/snd/pcmC${CARD_NUMBER}D*c; do
  if [ -e "$PCM_DEV" ]; then
    AUDIO_DEVICES="$AUDIO_DEVICES $PCM_DEV"
  fi
done
# Timer device (shared, only map once)
if [ -e "/dev/snd/timer" ] && ! echo "$AUDIO_DEVICES" | grep -q "/dev/snd/timer"; then
  AUDIO_DEVICES="$AUDIO_DEVICES /dev/snd/timer"
fi

if [ -z "$AUDIO_DEVICES" ]; then
  echo "Error: Could not find audio devices for card $AUDIO_CARD" >&2
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

# Determine if this is a USB device
USB_BUS_PATH=""
IS_USB=0
if [ -e "/sys/class/sound/$AUDIO_CARD/device" ]; then
  if find_vendor_product_from_class_device "sound" "$AUDIO_CARD"; then
    # Try to find USB device
    if find_usb_device_by_vendor_product "$VENDOR_ID" "$PRODUCT_ID" "$AUDIO_CARD" "sound/card*"; then
      USB_BUS_PATH=$(get_usb_bus_path "$USB_BUS" "$USB_DEVICE")
      if [ -n "$USB_BUS_PATH" ] && [ -e "$USB_BUS_PATH" ]; then
        IS_USB=1
      fi
    fi
  fi
fi

# Map devices based on VM type
if [ "$VM_TYPE" = "lxc" ]; then
  # LXC: Use devX: entries
  # Remove existing devX: entries for this card (but keep other entries)
  sed -i "/dev[0-9]*:.*\/dev\/snd\/controlC$CARD_NUMBER/d" "$CONFIG_FILE" 2>/dev/null || true
  
  # Map each audio device
  for DEVICE in $AUDIO_DEVICES; do
    DEV_INDEX=$(get_next_dev_index "$CONFIG_FILE")
    add_cgroup_allow "$CONFIG_FILE" "$DEVICE"
    echo "$DEV_INDEX: $DEVICE,uid=$CONTAINER_UID,gid=$CONTAINER_GID,mode=0666" >> "$CONFIG_FILE"
  done
  
  # Map USB bus device if USB audio device
  if [ "$IS_USB" = "1" ]; then
    map_usb_bus_device "$CONFIG_FILE" "$USB_BUS_PATH" "$CONTAINER_UID" "$CONTAINER_GID"
  fi
elif [ "$VM_TYPE" = "qemu" ]; then
  # QEMU: Use hostpciX: entries
  if [ "$IS_USB" = "1" ]; then
    # USB audio device: use vendor/product ID
    SYSFS_PATH=$(find_usb_sysfs_path "$USB_BUS" "$USB_DEVICE")
    if [ -z "$SYSFS_PATH" ] || ! get_vendor_product_id "$SYSFS_PATH"; then
      echo "Error: Could not determine vendor/product ID for USB audio device" >&2
      exit 1
    fi
    
    # Remove existing hostpci entries for this vendor/product
    sed -i "/^hostpci[0-9]*:.*${VENDOR_ID}:${PRODUCT_ID}/d" "$CONFIG_FILE"
    
    # Find next free hostpci slot
    HOSTPCI_SLOT=$(get_next_hostpci_slot "$CONFIG_FILE")
    
    # Add hostpci entry with USB vendor/product ID
    echo "hostpci${HOSTPCI_SLOT}: ${VENDOR_ID}:${PRODUCT_ID},usb3=1" >> "$CONFIG_FILE"
    echo "Mapped USB audio device (vendor: $VENDOR_ID, product: $PRODUCT_ID) to VM as hostpci${HOSTPCI_SLOT}" >&2
  else
    # PCI audio device: use PCI device ID
    # Get PCI device ID from /sys/class/sound/cardX/device
    PCI_DEVICE=$(readlink "/sys/class/sound/$AUDIO_CARD/device" 2>/dev/null | sed 's|.*/\([0-9a-f]\{4\}:[0-9a-f]\{2\}:[0-9a-f]\{2\}\.[0-9a-f]\)|\1|' || echo "")
    if [ -z "$PCI_DEVICE" ]; then
      # Try alternative method
      PCI_DEVICE=$(lspci -D | grep -i audio | awk '{print $1}' | head -n$((CARD_NUMBER+1)) | tail -n1 || echo "")
    fi
    
    if [ -z "$PCI_DEVICE" ]; then
      echo "Error: Could not determine PCI device ID for audio card $AUDIO_CARD" >&2
      exit 1
    fi
    
    # Remove existing hostpci entries for this PCI device
    sed -i "/^hostpci[0-9]*:.*${PCI_DEVICE}/d" "$CONFIG_FILE"
    
    # Find next free hostpci slot
    HOSTPCI_SLOT=$(get_next_hostpci_slot "$CONFIG_FILE")
    
    # Add hostpci entry with PCI device ID
    echo "hostpci${HOSTPCI_SLOT}: $PCI_DEVICE" >> "$CONFIG_FILE"
    echo "Mapped PCI audio device ($PCI_DEVICE) to VM as hostpci${HOSTPCI_SLOT}" >&2
  fi
fi

# Set permissions and create udev rules (only for LXC, VMs use hostpci passthrough)
if [ "$VM_TYPE" = "lxc" ]; then
  # Set permissions for all devices using library function
  for DEVICE in $AUDIO_DEVICES; do
    set_device_permissions "$DEVICE" "$CONTAINER_UID" "$CONTAINER_GID" "0666"
  done
  
  # Set permissions for USB bus device if USB audio device
  if [ "$IS_USB" = "1" ]; then
    set_device_permissions "$USB_BUS_PATH" "$CONTAINER_UID" "$CONTAINER_GID" "0664"
  fi
  
  # Create udev rule for USB devices only (PCI devices don't need udev rules)
  if [ "$IS_USB" = "1" ] && command -v udevadm >/dev/null 2>&1; then
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
      RULE_FILE="/etc/udev/rules.d/99-lxc-audio-${VM_ID}-${VENDOR_ID}-${PRODUCT_ID}.rules"
      
      # Install replug handler script (must be done before setup_udev_rule_with_replug)
      REPLUG_SCRIPT="/usr/local/bin/map-audio-device-replug.sh"
      if ! install_replug_handler "$REPLUG_SCRIPT" "$REPLUG_SCRIPT_CONTENT_AUDIO"; then
        echo "Error: Failed to install replug handler script" >&2
        return 1
      fi
      
      # Setup udev rule with replug handler using library function
      if ! setup_udev_rule_with_replug "$RULE_FILE" "$VENDOR_ID" "$PRODUCT_ID" "sound" "$MAPPED_UID" "$MAPPED_GID" "0666" "$REPLUG_SCRIPT" "${VM_ID}" "$AUDIO_CARD" "$CONTAINER_UID" "$CONTAINER_GID"; then
        echo "Error: Failed to setup udev rule with replug handler" >&2
        exit 1
      fi
    fi
  fi
fi

exit 0

# Store replug script content in variable (used by setup_udev_rules)
# Use quoted heredoc to prevent variable expansion in main script
REPLUG_SCRIPT_CONTENT_AUDIO=$(cat <<'REPLUG_SCRIPT_EOF'
#!/bin/sh
# Replug handler for audio device mapping
# Called by udev when USB audio device is plugged in
# Updates LXC container mapping for all audio devices
exec >&2

# Function to update LXC config for audio device mapping
# Parameters: config_file, audio_card, container_uid, container_gid, usb_bus_path
update_lxc_config_for_audio_devices() {
  CONFIG_FILE="\$1"
  AUDIO_CARD="\$2"
  CONTAINER_UID="\$3"
  CONTAINER_GID="\$4"
  USB_BUS_PATH="\$5"
  
  if [ -z "\$CONFIG_FILE" ] || [ -z "\$AUDIO_CARD" ]; then
    echo "Error: update_lxc_config_for_audio_devices requires config_file and audio_card" >&2
    return 1
  fi
  
  # Extract card number
  CARD_NUMBER=\$(echo "\$AUDIO_CARD" | sed 's/card//')
  
  # Find all audio devices for this card
  AUDIO_DEVICES=""
  if [ -e "/dev/snd/controlC\$CARD_NUMBER" ]; then
    AUDIO_DEVICES="\$AUDIO_DEVICES /dev/snd/controlC\$CARD_NUMBER"
  fi
  for PCM_DEV in /dev/snd/pcmC\${CARD_NUMBER}D*p /dev/snd/pcmC\${CARD_NUMBER}D*c; do
    if [ -e "\$PCM_DEV" ]; then
      AUDIO_DEVICES="\$AUDIO_DEVICES \$PCM_DEV"
    fi
  done
  if [ -e "/dev/snd/timer" ] && ! echo "\$AUDIO_DEVICES" | grep -q "/dev/snd/timer"; then
    AUDIO_DEVICES="\$AUDIO_DEVICES /dev/snd/timer"
  fi
  
  # Remove existing devX: entries for this card
  sed -i "/dev[0-9]*:.*\/dev\/snd\/controlC\$CARD_NUMBER/d" "\$CONFIG_FILE"
  
  # Remove old USB bus mount entries
  sed -i "/lxc.mount.entry.*dev\/bus\/usb/d" "\$CONFIG_FILE"
  
  # Remove old cgroup allow entries for audio devices
  sed -i "/^lxc.cgroup2.devices.allow = c.*snd/d" "\$CONFIG_FILE"
  
  # Add each audio device
  for DEVICE in \$AUDIO_DEVICES; do
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
AUDIO_CARD="\$4"
CONTAINER_UID="\$5"
CONTAINER_GID="\$6"

# Debug output
echo "Debug: Replug script called with parameters:" >&2
echo "  VM_ID=\$VM_ID" >&2
echo "  VENDOR_ID=\$VENDOR_ID" >&2
echo "  PRODUCT_ID=\$PRODUCT_ID" >&2
echo "  AUDIO_CARD=\$AUDIO_CARD" >&2
echo "  CONTAINER_UID=\$CONTAINER_UID" >&2
echo "  CONTAINER_GID=\$CONTAINER_GID" >&2

if [ -z "\$VM_ID" ] || [ -z "\$VENDOR_ID" ] || [ -z "\$PRODUCT_ID" ] || [ -z "\$AUDIO_CARD" ]; then
  echo "Error: Missing parameters (vm_id, vendor_id, product_id, audio_card)" >&2
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
    
    break
  fi
done

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

# Update LXC config for audio device mapping
if ! update_lxc_config_for_audio_devices "\$LXC_CONFIG_FILE" "\$AUDIO_CARD" "\$CONTAINER_UID" "\$CONTAINER_GID" "\$USB_BUS_PATH"; then
  echo "Error: Failed to update LXC config for audio devices" >&2
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
CARD_NUMBER=\$(echo "\$AUDIO_CARD" | sed 's/card//')
AUDIO_DEVICES=""
if [ -e "/dev/snd/controlC\$CARD_NUMBER" ]; then
  AUDIO_DEVICES="\$AUDIO_DEVICES /dev/snd/controlC\$CARD_NUMBER"
fi
for PCM_DEV in /dev/snd/pcmC\${CARD_NUMBER}D*p /dev/snd/pcmC\${CARD_NUMBER}D*c; do
  if [ -e "\$PCM_DEV" ]; then
    AUDIO_DEVICES="\$AUDIO_DEVICES \$PCM_DEV"
  fi
done
if [ -e "/dev/snd/timer" ] && ! echo "\$AUDIO_DEVICES" | grep -q "/dev/snd/timer"; then
  AUDIO_DEVICES="\$AUDIO_DEVICES /dev/snd/timer"
fi

for DEVICE in \$AUDIO_DEVICES; do
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
