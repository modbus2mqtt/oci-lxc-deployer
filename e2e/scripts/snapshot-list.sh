#!/bin/bash
# snapshot-list.sh - Lists snapshots for a VM or container
#
# Usage:
#   snapshot-list.sh <VMID>
#   SSH_HOST=10.99.0.10 snapshot-list.sh 300
#   PVE_HOST=ubuntupve snapshot-list.sh 9000

set -e

VMID="${1:?Usage: snapshot-list.sh <VMID>}"

# Determine SSH target
if [ -n "$SSH_HOST" ]; then
    SSH_TARGET="root@$SSH_HOST"
elif [ -n "$PVE_HOST" ]; then
    SSH_TARGET="root@$PVE_HOST"
else
    echo "[ERROR] Either SSH_HOST or PVE_HOST must be set" >&2
    exit 1
fi

echo "[INFO] Listing snapshots for VMID $VMID on $SSH_TARGET..."

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
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "qm listsnapshot $VMID"
        ;;
    lxc)
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "pct listsnapshot $VMID"
        ;;
    *)
        echo "[ERROR] VMID $VMID not found as VM or container on $SSH_TARGET" >&2
        exit 1
        ;;
esac
