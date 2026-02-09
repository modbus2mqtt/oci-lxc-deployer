#!/bin/bash
# snapshot-delete.sh - Deletes a snapshot from a VM or container
#
# Usage:
#   snapshot-delete.sh <VMID> <SNAPSHOT_NAME>
#   SSH_HOST=10.99.0.10 snapshot-delete.sh 300 old-snapshot
#   PVE_HOST=ubuntupve snapshot-delete.sh 9000 test-snapshot

set -e

VMID="${1:?Usage: snapshot-delete.sh <VMID> <SNAPSHOT_NAME>}"
SNAPSHOT_NAME="${2:?Usage: snapshot-delete.sh <VMID> <SNAPSHOT_NAME>}"

# Determine SSH target
if [ -n "$SSH_HOST" ]; then
    SSH_TARGET="root@$SSH_HOST"
elif [ -n "$PVE_HOST" ]; then
    SSH_TARGET="root@$PVE_HOST"
else
    echo "[ERROR] Either SSH_HOST or PVE_HOST must be set" >&2
    exit 1
fi

echo "[INFO] Deleting snapshot '$SNAPSHOT_NAME' from VMID $VMID on $SSH_TARGET..."

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
        echo "[INFO] Deleting QEMU VM snapshot..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "qm delsnapshot $VMID $SNAPSHOT_NAME"
        ;;
    lxc)
        echo "[INFO] Deleting LXC container snapshot..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "pct delsnapshot $VMID $SNAPSHOT_NAME"
        ;;
    *)
        echo "[ERROR] VMID $VMID not found as VM or container on $SSH_TARGET" >&2
        exit 1
        ;;
esac

echo "[OK] Snapshot '$SNAPSHOT_NAME' deleted from $VM_TYPE $VMID"
