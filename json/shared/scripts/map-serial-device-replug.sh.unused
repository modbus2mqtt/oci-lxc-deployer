#!/bin/sh
# Replug handler for serial device mapping
#
# This script is called by udev when a USB serial device is plugged in. It:
# 1. Finds the device by vendor/product ID
# 2. Updates LXC container configuration with device mapping
# 3. Creates symlink in container to stable device path
# 4. Sets proper permissions and ownership
#
# Parameters (passed from udev rule):
#   - vm_id: LXC container ID
#   - vendor_id: USB vendor ID
#   - product_id: USB product ID
#   - container_device_path: Device path in container (optional, default: /dev/ttyUSB0)
#   - container_uid: Container user ID (optional, default: 1000)
#   - container_gid: Container group ID (optional, default: 1000)
#
# Output: Errors to stderr
exec >&2

# Parameters passed from udev rule
VM_ID="$1"
VENDOR_ID="$2"
PRODUCT_ID="$3"
CONTAINER_DEVICE_PATH="$4"
CONTAINER_UID="$5"
CONTAINER_GID="$6"

if [ -z "$VM_ID" ] || [ -z "$VENDOR_ID" ] || [ -z "$PRODUCT_ID" ]; then
  echo "Error: Missing parameters (vm_id, vendor_id, product_id)" >&2
  exit 1
fi

# Use defaults if not provided
CONTAINER_DEVICE_PATH="${CONTAINER_DEVICE_PATH:-/dev/ttyUSB0}"
CONTAINER_UID="${CONTAINER_UID:-0}"
CONTAINER_GID="${CONTAINER_GID:-0}"

# Find the device by vendor/product ID
# We need to find the current bus:device for this vendor/product
SYSFS_BASE="/sys/bus/usb/devices"
ACTUAL_HOST_DEVICE=""
USB_BUS=""
USB_DEVICE=""

for USB_DEVICE_PATH in $SYSFS_BASE/*; do
  [ ! -d "$USB_DEVICE_PATH" ] && continue
  
  DEV_VENDOR=$(cat "$USB_DEVICE_PATH/idVendor" 2>/dev/null | tr -d '\n\r' || echo "")
  DEV_PRODUCT=$(cat "$USB_DEVICE_PATH/idProduct" 2>/dev/null | tr -d '\n\r' || echo "")
  
  if [ "$DEV_VENDOR" = "$VENDOR_ID" ] && [ "$DEV_PRODUCT" = "$PRODUCT_ID" ]; then
    # Found matching USB device, extract bus/device
    DEVICE_BASENAME=$(basename "$USB_DEVICE_PATH")
    USB_BUS=$(echo "$DEVICE_BASENAME" | sed -n 's/^\([0-9]*\)-.*/\1/p' | sed 's/^0*//' || echo "")
    USB_DEVICE=$(echo "$DEVICE_BASENAME" | sed -n 's/^[0-9]*-\([0-9]*\)[.:].*/\1/p' | sed 's/^0*//' || echo "")
    if [ -z "$USB_DEVICE" ]; then
      USB_DEVICE=$(echo "$DEVICE_BASENAME" | sed -n 's/^[0-9]*-\([0-9]*\)$/\1/p' | sed 's/^0*//' || echo "")
    fi
    
    # Find tty device
    SYSFS_PATTERN="$USB_BUS-$USB_DEVICE"
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
    
    if [ -n "$ACTUAL_HOST_DEVICE" ]; then
      break
    fi
  fi
done

if [ -z "$ACTUAL_HOST_DEVICE" ] || [ ! -e "$ACTUAL_HOST_DEVICE" ]; then
  echo "Device not found yet, may need to wait" >&2
  exit 0  # Not an error, device may appear later
fi

LXC_CONFIG_FILE="/etc/pve/lxc/${VM_ID}.conf"

# Update LXC config
# Remove old dev0 entry
sed -i '/^dev0:/d' "$LXC_CONFIG_FILE"

# Get major/minor for cgroup allow
STAT_OUTPUT=$(stat -c "%t %T" "$ACTUAL_HOST_DEVICE" 2>/dev/null || echo "")
if [ -n "$STAT_OUTPUT" ]; then
  MAJOR=$((0x$(echo "$STAT_OUTPUT" | awk '{print $1}')))
  MINOR=$((0x$(echo "$STAT_OUTPUT" | awk '{print $2}')))
  
  # Remove old cgroup allow entry
  sed -i "/^lxc.cgroup2.devices.allow = c $MAJOR:$MINOR/d" "$LXC_CONFIG_FILE"
  # Add new cgroup allow entry
  echo "lxc.cgroup2.devices.allow = c $MAJOR:$MINOR rwm" >> "$LXC_CONFIG_FILE"
fi

# Add new dev0 mapping (without mp=, as it's not supported)
echo "dev0: $ACTUAL_HOST_DEVICE,uid=$CONTAINER_UID,gid=$CONTAINER_GID,mode=0664" >> "$LXC_CONFIG_FILE"

# Create symlink in container to stable path
# Wait a moment for container to be ready if it's running
if pct status "$VM_ID" 2>&1 | grep -q 'status: running'; then
  sleep 1
  # Create symlink in container to stable path
  HOST_DEVICE_NAME=$(basename "$ACTUAL_HOST_DEVICE")
  lxc-attach -n "$VM_ID" -- sh -c "ln -sf /dev/$HOST_DEVICE_NAME $CONTAINER_DEVICE_PATH 2>/dev/null || true" 2>&1 || true
fi

# Set permissions
MAPPED_UID=$((CONTAINER_UID + 100000))
MAPPED_GID=$((CONTAINER_GID + 100000))
chown "$MAPPED_UID:$MAPPED_GID" "$ACTUAL_HOST_DEVICE" 2>/dev/null || true
chmod 664 "$ACTUAL_HOST_DEVICE" 2>/dev/null || true

exit 0

