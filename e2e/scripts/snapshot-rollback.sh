#!/bin/bash
# snapshot-rollback.sh - Rolls back a VM or container to a snapshot
#
# For VMs (QEMU): Uses qm rollback (stops VM, rolls back, starts)
# For containers (LXC): Uses pct rollback
#
# Usage:
#   snapshot-rollback.sh <VMID> [SNAPSHOT_NAME]
#   SSH_HOST=10.99.0.10 snapshot-rollback.sh 300 baseline
#   PVE_HOST=ubuntupve snapshot-rollback.sh 9000 clean-install

set -e

VMID="${1:?Usage: snapshot-rollback.sh <VMID> [SNAPSHOT_NAME]}"
SNAPSHOT_NAME="${2:-baseline}"

# Determine SSH target
if [ -n "$SSH_HOST" ]; then
    SSH_TARGET="root@$SSH_HOST"
elif [ -n "$PVE_HOST" ]; then
    SSH_TARGET="root@$PVE_HOST"
else
    echo "[ERROR] Either SSH_HOST or PVE_HOST must be set" >&2
    exit 1
fi

echo "[INFO] Rolling back VMID $VMID to snapshot '$SNAPSHOT_NAME' on $SSH_TARGET..."

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
        echo "[INFO] Stopping VM if running..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "qm stop $VMID" 2>/dev/null || true
        sleep 3

        echo "[INFO] Rolling back QEMU VM to snapshot..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "qm rollback $VMID $SNAPSHOT_NAME"

        echo "[INFO] Starting VM..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "qm start $VMID"
        ;;
    lxc)
        echo "[INFO] Stopping container if running..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "pct stop $VMID" 2>/dev/null || true
        sleep 2

        echo "[INFO] Rolling back LXC container to snapshot..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "pct rollback $VMID $SNAPSHOT_NAME"

        echo "[INFO] Starting container..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "pct start $VMID"
        ;;
    *)
        echo "[ERROR] VMID $VMID not found as VM or container on $SSH_TARGET" >&2
        exit 1
        ;;
esac

# Wait for VM/container to be fully running
echo "[INFO] Waiting for $VM_TYPE $VMID to be ready..."
for i in $(seq 1 60); do
    STATUS=$(ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "
        if [ '$VM_TYPE' = 'qemu' ]; then
            qm status $VMID 2>/dev/null | grep -q 'running' && echo 'running'
        else
            pct status $VMID 2>/dev/null | grep -q 'running' && echo 'running'
        fi
    ")
    if [ "$STATUS" = "running" ]; then
        echo "[OK] $VM_TYPE $VMID rolled back and running"
        exit 0
    fi
    sleep 1
done

echo "[WARN] Timeout waiting for $VM_TYPE to start, but rollback completed"
exit 0
