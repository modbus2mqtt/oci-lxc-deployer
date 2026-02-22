

#!/bin/sh
# Redirect Proxmox host console to a USB serial port and disable the graphics card output
# Usage: Run as root. Adjust SERIAL_DEV if needed.

if ! lspci | grep -qi vga; then
  echo "No VGA-compatible graphics card found. Aborting." >&2
  exit 1
fi
OUTPUT_NAME="default"
set -e
BAUD=115200

# Find the first ungplugged ttyUSB device (Which is not yet present)
LAST_USB=$(ls /dev/ttyUSB* 2>/dev/null | sed 's|/dev/ttyUSB||' | sort -n | tail -n1)
if [ -z "$LAST_USB" ]; then
  NEXT_USB=0
else
  NEXT_USB=$((LAST_USB + 1))
fi
SERIAL_DEV="ttyUSB$NEXT_USB"
echo "Will use /dev/$SERIAL_DEV as the console device. Please plug in the console adapter only when needed!" >&2

# 4. Enable serial console in /etc/default/grub
echo "Updating /etc/default/grub for serial console..." >&2
sed -i.bak \
  's/GRUB_CMDLINE_LINUX_DEFAULT="/GRUB_CMDLINE_LINUX_DEFAULT="console=tty0 console='"$SERIAL_DEV"','"$BAUD"' /' \
  /etc/default/grub

# 2. Add serial terminal to /etc/inittab (for SysVinit) or systemd service (for systemd)
if [ -d /etc/systemd ]; then
  SERVICE_FILE="/etc/systemd/system/serial-getty@${SERIAL_DEV}.service"
  if [ ! -f "$SERVICE_FILE" ]; then
    echo "Creating systemd service for serial console..." >&2
    ln -sf /lib/systemd/system/serial-getty@.service "$SERVICE_FILE"
    systemctl daemon-reload
    systemctl enable serial-getty@${SERIAL_DEV}.service
  fi
else
  if ! grep -q "${SERIAL_DEV}" /etc/inittab 2>/dev/null; then
    echo "Adding ${SERIAL_DEV} to /etc/inittab..." >&2
    echo "T0:23:respawn:/sbin/getty -L ${SERIAL_DEV} $BAUD vt102" >> /etc/inittab
  fi
fi

# 3. Disable graphics output via kernel parameter
VIDEO_PARAM="video=${OUTPUT_NAME}:d"
if ! grep -q "$VIDEO_PARAM" /etc/default/grub; then
  echo "Disabling $OUTPUT_NAME output in /etc/default/grub..." >&2
  sed -i.bak \
    "s/GRUB_CMDLINE_LINUX_DEFAULT=\"/GRUB_CMDLINE_LINUX_DEFAULT=\"$VIDEO_PARAM /" \
    /etc/default/grub
fi

# 4. Update grub and reboot required
update-grub >&2

echo "Serial console enabled on /dev/$SERIAL_DEV ($BAUD baud)." >&2
echo "Graphics output disabled." >&2
echo "Please reboot the host to apply changes." >&2

