#!/bin/sh
# List all audio devices (USB and PCI) on the VE host that are not already mapped to running LXC containers
#
# This script lists all available audio devices by:
# 1. Scanning /sys/class/sound for audio cards
# 2. Extracting device information (name, card number)
# 3. Checking which devices are already mapped to running containers (USB only)
# 4. Formatting as JSON array for enumValues
#
# Output format: JSON array of objects with name and value fields
# Example: [{"name":"USB Audio Device","value":"card0"}, ...]
#
# Library: usb-device-common.sh (automatically prepended)
#
# Output: JSON to stdout (errors to stderr)
exec >&2

set -e

# Check prerequisites
if [ ! -d "/sys/class/sound" ]; then
  echo "Error: /sys/class/sound directory not found." >&2
  exit 1
fi

FIRST=true
printf '['

# Process all audio cards
for SOUND_CARD in /sys/class/sound/card*; do
  [ ! -e "$SOUND_CARD" ] && continue
  
  CARD_NAME=$(basename "$SOUND_CARD")
  CARD_NUMBER=$(echo "$CARD_NAME" | sed 's/card//')
  
  # Find vendor/product ID from class device using library function
  if ! find_vendor_product_from_class_device "sound" "$CARD_NAME"; then
    continue
  fi
  
  # Determine if this is a USB or PCI device
  DEVICE_TYPE=""
  DEVICE_INFO=""
  
  # Check if device is USB by trying to find USB device
  if find_usb_device_by_vendor_product "$VENDOR_ID" "$PRODUCT_ID" "$CARD_NAME" "sound/card*"; then
    DEVICE_TYPE="USB"
    
    # Skip if USB device is already mapped to a running container
    if is_usb_device_mapped_in_running_containers "$USB_BUS" "$USB_DEVICE"; then
      continue
    fi
    
    # Get lsusb description using library function
    DEVICE_INFO=$(get_lsusb_description "$USB_BUS" "$USB_DEVICE" || echo "")
  else
    # Check if device is PCI by navigating from /sys/class/sound/cardX/device
    if [ -e "$SOUND_CARD/device" ]; then
      if command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
        DEVICE_LINK=$(readlink -f "$SOUND_CARD/device" 2>/dev/null || echo "")
      else
        DEVICE_LINK=$(readlink "$SOUND_CARD/device" 2>/dev/null || echo "")
        if [ -n "$DEVICE_LINK" ] && [ "${DEVICE_LINK#/}" = "$DEVICE_LINK" ]; then
          DEVICE_LINK="/sys/class/sound/$CARD_NAME/$DEVICE_LINK"
        fi
      fi
      
      if [ -n "$DEVICE_LINK" ]; then
        # Navigate up to find PCI device
        CURRENT_DIR="$DEVICE_LINK"
        MAX_LEVELS=10
        LEVEL=0
        
        while [ $LEVEL -lt $MAX_LEVELS ]; do
          if echo "$CURRENT_DIR" | grep -q '/sys/bus/pci/devices/'; then
            PCI_DEVICE=$(basename "$CURRENT_DIR")
            DEVICE_TYPE="PCI"
            # Get PCI device description using lspci
            if command -v lspci >/dev/null 2>&1; then
              DEVICE_INFO=$(lspci -nnk -s "$PCI_DEVICE" 2>/dev/null | head -n1 | sed 's/^[^ ]* //' || echo "")
            fi
            break
          fi
          PARENT_DIR=$(dirname "$CURRENT_DIR" 2>/dev/null || echo "")
          if [ "$PARENT_DIR" = "$CURRENT_DIR" ] || [ "$PARENT_DIR" = "/" ] || [ -z "$PARENT_DIR" ]; then
            break
          fi
          CURRENT_DIR="$PARENT_DIR"
          LEVEL=$((LEVEL + 1))
        done
      fi
    fi
  fi
  
  # Create name (with card number and device type)
  if [ -n "$DEVICE_INFO" ] && [ "$DEVICE_INFO" != "" ]; then
    if [ "$DEVICE_TYPE" = "USB" ]; then
      NAME_TEXT="$DEVICE_INFO (USB, card$CARD_NUMBER)"
    elif [ "$DEVICE_TYPE" = "PCI" ]; then
      NAME_TEXT="$DEVICE_INFO (PCI, card$CARD_NUMBER)"
    else
      NAME_TEXT="$DEVICE_INFO (card$CARD_NUMBER)"
    fi
  elif [ -n "$VENDOR_ID" ] && [ -n "$PRODUCT_ID" ]; then
    if [ "$DEVICE_TYPE" = "USB" ]; then
      NAME_TEXT="ID ${VENDOR_ID}:${PRODUCT_ID} (USB, card$CARD_NUMBER)"
    elif [ "$DEVICE_TYPE" = "PCI" ]; then
      NAME_TEXT="ID ${VENDOR_ID}:${PRODUCT_ID} (PCI, card$CARD_NUMBER)"
    else
      NAME_TEXT="ID ${VENDOR_ID}:${PRODUCT_ID} (card$CARD_NUMBER)"
    fi
  else
    NAME_TEXT="$CARD_NAME"
  fi
  
  # Format and output JSON entry using library function
  # Use card number as value (e.g., "card0")
  format_json_device_entry "$NAME_TEXT" "$CARD_NAME" "$FIRST"
  FIRST=false
done

printf ']'
exit 0

