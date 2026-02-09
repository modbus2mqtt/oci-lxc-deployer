#!/bin/bash
# snapshot-create.sh - Creates a snapshot of a VM or container
#
# For VMs (QEMU): Uses qm snapshot (works with ZFS automatically)
# For containers (LXC): Uses pct snapshot or direct ZFS
#
# Usage:
#   snapshot-create.sh <VMID> [SNAPSHOT_NAME]
#   SSH_HOST=10.99.0.10 snapshot-create.sh 300 baseline
#   PVE_HOST=ubuntupve snapshot-create.sh 9000 clean-install

set -e

VMID="${1:?Usage: snapshot-create.sh <VMID> [SNAPSHOT_NAME]}"
SNAPSHOT_NAME="${2:-baseline}"

# Determine SSH target
# SSH_HOST is for nested VM access (via SSH)
# PVE_HOST is for direct Proxmox host access
if [ -n "$SSH_HOST" ]; then
    SSH_TARGET="root@$SSH_HOST"
elif [ -n "$PVE_HOST" ]; then
    SSH_TARGET="root@$PVE_HOST"
else
    echo "[ERROR] Either SSH_HOST or PVE_HOST must be set" >&2
    exit 1
fi

echo "[INFO] Creating snapshot '$SNAPSHOT_NAME' for VMID $VMID on $SSH_TARGET..."

# Determine if this is a VM (qm) or container (pct)
VM_TYPE=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "$SSH_TARGET" "
    if qm status $VMID &>/dev/null; then
        echo 'qemu'
    elif pct status $VMID &>/dev/null; then
        echo 'lxc'
    else
        echo 'unknown'
    fi
")

case "$VM_TYPE" in
    qemu)
        echo "[INFO] Creating QEMU VM snapshot..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "qm snapshot $VMID $SNAPSHOT_NAME --description 'E2E test snapshot'"
        ;;
    lxc)
        echo "[INFO] Creating LXC container snapshot..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "pct snapshot $VMID $SNAPSHOT_NAME --description 'E2E test snapshot'"
        ;;
    *)
        echo "[ERROR] VMID $VMID not found as VM or container on $SSH_TARGET" >&2
        exit 1
        ;;
esac

echo "[OK] Snapshot '$SNAPSHOT_NAME' created for $VM_TYPE $VMID"
