#!/bin/sh
# Re-enable VGA/graphics output for console on Proxmox host
# Usage: Run as root. This will remove the 'video=default:d' kernel parameter and restore default console output.

if ! lspci | grep -qi vga; then
  echo "No VGA-compatible graphics card found. Aborting." >&2
  exit 1
fi

set -e

# 1. Remove VGA disable parameter from /etc/default/grub
if grep -q "video=default:d" /etc/default/grub; then
  echo "Restoring VGA output in /etc/default/grub..." >&2
  sed -i.bak 's/video=default:d //' /etc/default/grub
fi

# 3. Update grub and inform user
update-grub >&2

echo "VGA output re-enabled. Please reboot the host to apply changes." >&2
