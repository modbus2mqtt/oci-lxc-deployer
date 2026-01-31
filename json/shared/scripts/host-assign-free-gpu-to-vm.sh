#!/bin/sh
# Assign a free GPU to a Proxmox VM
# Usage: This script expects the variable {{ vm_id }} to be set (template style)

set -e
VMID="{{ vm_id }}"

if [ -z "$VMID" ]; then
  echo "Error: VMID must be set." >&2
  exit 1
fi

# 1. Check if VM is running
VM_STATE=$(qm status "$VMID" | awk '{print $2}')
WAS_RUNNING=0
if [ "$VM_STATE" = "running" ]; then
  echo "Stopping VM $VMID..." >&2
  qm stop "$VMID"
  WAS_RUNNING=1
fi

# 2. List all PCI GPUs
ALL_GPUS=$(lspci -Dn | grep -i 'vga\|3d\|display' | awk '{print $1}')
if [ -z "$ALL_GPUS" ]; then
  echo "No GPUs found on this host." >&2
  exit 1
fi

# 3. Find GPUs already assigned to VMs
USED_GPUS=$(grep -h ^hostpci /etc/pve/qemu-server/*.conf 2>/dev/null | awk -F',' '{print $1}' | awk -F' ' '{print $2}')

# 3a. Find GPUs used by the host (not disabled in kernel parameter)
HOST_GPUS=""
KERNEL_PARAMS=$(grep -E '^GRUB_CMDLINE_LINUX_DEFAULT=' /etc/default/grub | cut -d'"' -f2)
for GPU in $ALL_GPUS; do
  PCI_ID="$GPU"
  # Try to determine the output name (e.g. VGA-1, default, HDMI-1)
  # Assumption: The order of lspci matches the order of outputs (not always guaranteed)
  # Look for video=<output>:d in the kernel parameter
  GPU_DISABLED=0
  for PARAM in $KERNEL_PARAMS; do
    if echo "$PARAM" | grep -q '^video='; then
      OUTNAME=$(echo "$PARAM" | sed -n 's/^video=\([^:]*\):.*/\1/p')
      # If :d is set, the output is disabled
      if echo "$PARAM" | grep -q ':d'; then
        continue
      fi
      # If not :d, this output is active
      # We cannot directly map PCI-ID to output name, but assume: first GPU = first output
      # So: If any output is not :d, mark the first GPU as host GPU
      HOST_GPUS="$PCI_ID $HOST_GPUS"
      break
    fi
  done
done

# 4. Find first free GPU (not used by any VM or host)
FREE_GPU=""
for GPU in $ALL_GPUS; do
  IN_USE=0
  for USED in $USED_GPUS $HOST_GPUS; do
    if [ "$GPU" = "$USED" ]; then
      IN_USE=1
      break
    fi
  done
  if [ $IN_USE -eq 0 ]; then
    FREE_GPU="$GPU"
    break
  fi
done

if [ -z "$FREE_GPU" ]; then
  echo "No free GPU found (all are used by VMs or host). Aborting." >&2
  exit 1
fi

# 5. Assign GPU to VM
# Find next free hostpci slot
NEXT_SLOT=0
while grep -q "^hostpci$NEXT_SLOT" /etc/pve/qemu-server/$VMID.conf 2>/dev/null; do
  NEXT_SLOT=$((NEXT_SLOT+1))
done

echo "Assigning GPU $FREE_GPU to VM $VMID as hostpci$NEXT_SLOT..." >&2
qm set "$VMID" -hostpci$NEXT_SLOT "$FREE_GPU"

# 6. Restart VM if it was running
if [ "$WAS_RUNNING" = "1" ]; then
  echo "Restarting VM $VMID..." >&2
  qm start "$VMID"
fi

echo "Done. GPU $FREE_GPU assigned to VM $VMID (hostpci$NEXT_SLOT)." >&2
