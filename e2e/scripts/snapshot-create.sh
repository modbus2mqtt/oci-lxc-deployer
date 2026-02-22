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
        echo "[INFO] Shutting down VM gracefully..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "qm shutdown $VMID --timeout 30" 2>/dev/null || true

        # Wait for VM to be fully stopped
        echo "[INFO] Waiting for VM to stop..."
        for i in $(seq 1 30); do
            STATUS=$(ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "qm status $VMID 2>/dev/null | grep -oP 'status: \K\w+'")
            if [ "$STATUS" = "stopped" ]; then
                echo "[INFO] VM stopped after ${i}s"
                break
            fi
            sleep 1
        done

        # Force stop if still running
        if [ "$STATUS" != "stopped" ]; then
            echo "[WARN] Graceful shutdown timed out, forcing stop..."
            ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "qm stop $VMID" 2>/dev/null || true
            sleep 2
        fi

        echo "[INFO] Creating QEMU VM snapshot..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "qm snapshot $VMID $SNAPSHOT_NAME --description 'E2E test snapshot'"

        echo "[INFO] Starting VM after snapshot..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "qm start $VMID"
        ;;
    lxc)
        echo "[INFO] Stopping container before snapshot..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "pct stop $VMID" 2>/dev/null || true
        sleep 2

        echo "[INFO] Creating LXC container snapshot..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "pct snapshot $VMID $SNAPSHOT_NAME --description 'E2E test snapshot'"

        echo "[INFO] Starting container after snapshot..."
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "pct start $VMID"
        ;;
    *)
        echo "[ERROR] VMID $VMID not found as VM or container on $SSH_TARGET" >&2
        exit 1
        ;;
esac

# Wait for VM/container to be fully running
echo "[INFO] Waiting for $VM_TYPE $VMID to be ready after snapshot..."
for i in $(seq 1 60); do
    STATUS=$(ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "
        if [ '$VM_TYPE' = 'qemu' ]; then
            qm status $VMID 2>/dev/null | grep -q 'running' && echo 'running'
        else
            pct status $VMID 2>/dev/null | grep -q 'running' && echo 'running'
        fi
    ")
    if [ "$STATUS" = "running" ]; then
        echo "[OK] Snapshot '$SNAPSHOT_NAME' created for $VM_TYPE $VMID"
        exit 0
    fi
    sleep 1
done

echo "[WARN] Timeout waiting for $VM_TYPE to start, but snapshot completed"
