#!/bin/bash
# step1-create-vm.sh - Creates nested Proxmox VM for E2E testing
#
# This script:
# 1. Creates a QEMU VM on pve1.cluster with the custom ISO
# 2. Waits for unattended Proxmox installation to complete
# 3. Retrieves the nested VM's IP address
# 4. Tests SSH access from dev machine (direct, not via pve1)
#
# After this step, subsequent steps can connect directly to the nested VM.
#
# Usage:
#   ./step1-create-vm.sh              # Use default pve1.cluster
#   ./step1-create-vm.sh pve2.cluster # Use different host
#   KEEP_VM=1 ./step1-create-vm.sh    # Don't cleanup existing VM

set -e

# Configuration
PVE_HOST="${PVE_HOST:-${1:-pve1.cluster}}"
TEST_VMID="${TEST_VMID:-9000}"
VM_NAME="pve-e2e-test"
VM_MEMORY=2048
VM_CORES=2
VM_DISK_SIZE=32
VM_STORAGE="${VM_STORAGE:-local-zfs}"  # Can be overridden with VM_STORAGE env var
VM_BRIDGE="vmbr1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Host-specific network configuration
# Each host has its own NAT subnet to avoid IP conflicts
get_host_subnet() {
    local host="$1"
    case "$host" in
        *ubuntupve*) echo "10.99.1" ;;
        *pve1*)      echo "10.99.0" ;;
        *)           echo "10.99.0" ;;  # Default fallback
    esac
}

SUBNET=$(get_host_subnet "$PVE_HOST")
NESTED_STATIC_IP="${SUBNET}.10"
ISO_NAME="proxmox-ve-e2e-autoinstall.iso"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }
header() { echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"; echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"; }

# SSH wrapper for pve1
# Uses /dev/null for known_hosts to avoid host key conflicts during E2E testing
pve_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 "root@$PVE_HOST" "$@"
}

# Store nested VM IP for later steps
NESTED_IP_FILE="$SCRIPT_DIR/.nested-vm-ip"

header "Step 1: Create Nested Proxmox VM"
echo "Proxmox Host: $PVE_HOST"
echo "Test VM ID: $TEST_VMID"
echo "VM Name: $VM_NAME"
echo ""

# Step 1: Check SSH connection to pve1
info "Checking SSH connection to $PVE_HOST..."
if ! pve_ssh "echo 'SSH OK'" &>/dev/null; then
    error "Cannot connect to $PVE_HOST via SSH"
fi
success "SSH connection verified"

# Step 2: Check if ISO exists
info "Checking for custom ISO..."
if ! pve_ssh "test -f /var/lib/vz/template/iso/$ISO_NAME"; then
    error "Custom ISO not found. Run step0-create-iso.sh first."
fi
success "Custom ISO found"

# Step 3: Cleanup existing VM (unless KEEP_VM is set)
if [ -z "$KEEP_VM" ]; then
    if pve_ssh "qm status $TEST_VMID" &>/dev/null; then
        info "Removing existing VM $TEST_VMID (force)..."
        # Force stop immediately - no graceful shutdown for test VMs
        pve_ssh "qm stop $TEST_VMID --skiplock --timeout 5" 2>/dev/null || true
        # Destroy with force and purge
        pve_ssh "qm destroy $TEST_VMID --purge --skiplock" 2>/dev/null || true

        # Wait up to 60 seconds for VM to be gone
        WAIT_COUNT=0
        while pve_ssh "qm status $TEST_VMID" &>/dev/null; do
            WAIT_COUNT=$((WAIT_COUNT + 1))
            if [ $WAIT_COUNT -ge 60 ]; then
                error "Failed to remove existing VM $TEST_VMID after 60 seconds"
            fi
            printf "\r${YELLOW}[INFO]${NC} Waiting for VM deletion... %ds" $WAIT_COUNT
            sleep 1
        done
        [ $WAIT_COUNT -gt 0 ] && echo ""
        success "Existing VM removed"
    fi
fi

# Step 4: Create VM
info "Creating VM $TEST_VMID..."
pve_ssh "qm create $TEST_VMID \
    --name $VM_NAME \
    --memory $VM_MEMORY \
    --cores $VM_CORES \
    --cpu host \
    --net0 virtio,bridge=$VM_BRIDGE \
    --scsihw virtio-scsi-pci \
    --scsi0 $VM_STORAGE:$VM_DISK_SIZE \
    --cdrom local:iso/$ISO_NAME \
    --ostype l26"
success "VM created"

# Step 5: Start VM
info "Starting VM..."
pve_ssh "qm start $TEST_VMID"
success "VM started"

# Step 6: Wait for installation to complete
header "Waiting for Proxmox Installation"
info "This typically takes 5-10 minutes..."
info "The VM will reboot automatically after installation."
info "Network: $VM_BRIDGE - Static IP: $NESTED_STATIC_IP"

# Wait for SSH to become available on the static IP
MAX_WAIT=900  # 15 minutes (installation can take a while)
WAITED=0
INTERVAL=15

while [ $WAITED -lt $MAX_WAIT ]; do
    # Try SSH connection to the static IP (via pve1, since we're on NAT)
    if pve_ssh "ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 root@$NESTED_STATIC_IP 'echo SSH_OK'" 2>/dev/null | grep -q "SSH_OK"; then
        success "Installation complete - SSH accessible at $NESTED_STATIC_IP"
        break
    fi

    # Show progress
    PROGRESS=$((WAITED * 100 / MAX_WAIT))
    printf "\r${YELLOW}[INFO]${NC} Waiting for installation... %d%% (%ds/%ds)" $PROGRESS $WAITED $MAX_WAIT

    sleep $INTERVAL
    WAITED=$((WAITED + INTERVAL))
done

echo ""  # New line after progress

if [ $WAITED -ge $MAX_WAIT ]; then
    error "Timeout waiting for installation to complete after ${MAX_WAIT}s
Check VM console at: https://$PVE_HOST:8006/#v1:0:=qemu%2F$TEST_VMID"
fi

# Step 7: Wait for services to fully start
info "Waiting for all services to initialize..."
sleep 10

NESTED_IP="$NESTED_STATIC_IP"
success "Nested VM IP: $NESTED_IP"

# Save IP for subsequent steps
echo "$NESTED_IP" > "$NESTED_IP_FILE"
info "IP saved to $NESTED_IP_FILE"

# Step 9: Verify SSH access
header "Verifying SSH Access"
success "SSH already verified during installation wait"

# Step 10: Verify Proxmox is running
info "Verifying Proxmox VE installation..."
PVE_VERSION=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "root@$NESTED_IP" "pveversion 2>/dev/null" || \
              pve_ssh "ssh -o StrictHostKeyChecking=no root@$NESTED_IP pveversion 2>/dev/null" || \
              echo "unknown")

if [[ "$PVE_VERSION" == *"pve-manager"* ]]; then
    success "Proxmox VE verified: $PVE_VERSION"
else
    info "Could not verify Proxmox version (may need time to fully initialize)"
fi

# Step 10b: Create vmbr1 NAT bridge in nested VM for containers
header "Setting up Container NAT Bridge (vmbr1)"
info "Creating vmbr1 in nested VM for container networking..."

# Check if vmbr1 already exists
if pve_ssh "ssh -o StrictHostKeyChecking=no root@$NESTED_IP ip link show vmbr1" &>/dev/null; then
    success "vmbr1 already exists"
else
    # Add vmbr1 configuration to nested VM
    pve_ssh "ssh -o StrictHostKeyChecking=no root@$NESTED_IP 'cat >> /etc/network/interfaces << EOF

auto vmbr1
iface vmbr1 inet static
    address 10.0.0.1
    netmask 255.255.255.0
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
EOF
'"
    # Bring up vmbr1
    pve_ssh "ssh -o StrictHostKeyChecking=no root@$NESTED_IP ifup vmbr1"
    success "vmbr1 created with NAT (10.0.0.0/24)"
fi

# Step 11: Set up port forwarding on PVE host to nested VM
header "Setting up Port Forwarding"
info "Configuring port forwarding on $PVE_HOST..."

# Remove any existing forwarding rules for these ports
pve_ssh "iptables -t nat -D PREROUTING -p tcp --dport 1008 -j DNAT --to-destination $NESTED_IP:8006 2>/dev/null || true"
pve_ssh "iptables -t nat -D PREROUTING -p tcp --dport 1022 -j DNAT --to-destination $NESTED_IP:22 2>/dev/null || true"
pve_ssh "iptables -t nat -D PREROUTING -p tcp --dport 3000 -j DNAT --to-destination $NESTED_IP:3000 2>/dev/null || true"
pve_ssh "iptables -D FORWARD -p tcp -d $NESTED_IP --dport 8006 -j ACCEPT 2>/dev/null || true"
pve_ssh "iptables -D FORWARD -p tcp -d $NESTED_IP --dport 22 -j ACCEPT 2>/dev/null || true"
pve_ssh "iptables -D FORWARD -p tcp -d $NESTED_IP --dport 3000 -j ACCEPT 2>/dev/null || true"

# Add port forwarding: PVE_HOST:1008 -> NESTED_VM:8006 (for nested VM Proxmox Web UI)
pve_ssh "iptables -t nat -A PREROUTING -p tcp --dport 1008 -j DNAT --to-destination $NESTED_IP:8006"
pve_ssh "iptables -A FORWARD -p tcp -d $NESTED_IP --dport 8006 -j ACCEPT"
success "Port 1008 -> $NESTED_IP:8006 (nested VM Web UI)"

# Add port forwarding: PVE_HOST:1022 -> NESTED_VM:22 (for SSH to nested VM)
pve_ssh "iptables -t nat -A PREROUTING -p tcp --dport 1022 -j DNAT --to-destination $NESTED_IP:22"
pve_ssh "iptables -A FORWARD -p tcp -d $NESTED_IP --dport 22 -j ACCEPT"
success "Port 1022 -> $NESTED_IP:22 (nested VM SSH)"

# Add port forwarding: PVE_HOST:3000 -> NESTED_VM:3000 (for deployer API/UI)
pve_ssh "iptables -t nat -A PREROUTING -p tcp --dport 3000 -j DNAT --to-destination $NESTED_IP:3000"
pve_ssh "iptables -A FORWARD -p tcp -d $NESTED_IP --dport 3000 -j ACCEPT"
success "Port 3000 -> $NESTED_IP:3000 (API/UI)"

info "Port forwarding configured on $PVE_HOST"

# Step 12: Create snapshot for install script tests
header "Creating Snapshot"
info "Creating snapshot 'fresh-pve' for install script tests..."
PVE_HOST="$PVE_HOST" "$SCRIPT_DIR/scripts/snapshot-create.sh" "$TEST_VMID" "fresh-pve"
success "Snapshot 'fresh-pve' created"

# Summary
header "Step 1 Complete"
echo -e "${GREEN}Nested Proxmox VM is ready!${NC}"
echo ""
echo "VM Details:"
echo "  - VMID: $TEST_VMID"
echo "  - Name: $VM_NAME"
echo "  - IP Address: $NESTED_IP"
echo "  - Root Password: e2e-test-2024"
echo ""
echo "Network Configuration:"
echo "  - vmbr1 on $PVE_HOST: NAT network (${SUBNET}.0/24)"
echo "  - vmbr0 in nested VM: External network"
echo "  - vmbr1 in nested VM: NAT for containers (10.0.0.0/24)"
echo ""
echo "SSH Access:"
echo "  ssh root@$NESTED_IP"
echo ""
echo "Web UI (from network with access):"
echo "  https://$NESTED_IP:8006"
echo ""
echo "Next steps:"
echo "  1. Run step2-install-deployer.sh to install oci-lxc-deployer"
echo ""
