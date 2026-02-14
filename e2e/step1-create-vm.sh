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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load shared configuration
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

# Load config: use positional arg as instance name, or default
load_config "${1:-}"

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
info "Creating VM $TEST_VMID (disk: ${VM_DISK_SIZE}G on $VM_STORAGE)..."
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

# Ensure sshpass is installed on PVE host for password-based SSH during setup
if ! pve_ssh "command -v sshpass" &>/dev/null; then
    info "Installing sshpass on $PVE_HOST..."
    pve_ssh "apt-get update && apt-get install -y sshpass" &>/dev/null
    success "sshpass installed"
fi

# Wait for SSH to become available on the static IP
MAX_WAIT=900  # 15 minutes (installation can take a while)
WAITED=0
INTERVAL=15

while [ $WAITED -lt $MAX_WAIT ]; do
    # Try SSH connection with password (new VM doesn't have our keys yet)
    if pve_ssh "sshpass -p '$NESTED_PASSWORD' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@$NESTED_STATIC_IP 'echo SSH_OK'" 2>/dev/null | grep -q "SSH_OK"; then
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

# Step 7: Copy SSH keys and wait for services
# First, clean up any old known_hosts entries on PVE host
pve_ssh "ssh-keygen -R $NESTED_STATIC_IP 2>/dev/null || true"

# Note: Proxmox VE uses /etc/pve/priv/authorized_keys (symlinked from ~/.ssh/authorized_keys)
# On fresh installations, /etc/pve/priv/ may not exist yet, so we create it
# Fallback to ~/.ssh/authorized_keys if /etc/pve/priv/ doesn't work

info "Copying PVE host SSH keys to nested VM..."
PVE_HOST_PUBKEY=$(pve_ssh "cat ~/.ssh/id_rsa.pub 2>/dev/null || cat ~/.ssh/id_ed25519.pub 2>/dev/null")

# Copy local machine's SSH key
LOCAL_PUBKEY=""
for keyfile in ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub; do
    if [ -f "$keyfile" ]; then
        LOCAL_PUBKEY=$(cat "$keyfile")
        break
    fi
done

# Combine all keys
ALL_KEYS=""
[ -n "$PVE_HOST_PUBKEY" ] && ALL_KEYS="$PVE_HOST_PUBKEY"
if [ -n "$LOCAL_PUBKEY" ]; then
    [ -n "$ALL_KEYS" ] && ALL_KEYS="$ALL_KEYS"$'\n'"$LOCAL_PUBKEY" || ALL_KEYS="$LOCAL_PUBKEY"
fi

if [ -n "$ALL_KEYS" ]; then
    # Write keys to a temp file on PVE host, then copy to nested VM
    # This is more reliable than trying to echo multi-line content through nested SSH
    pve_ssh "cat > /tmp/nested_keys.pub << 'KEYS_EOF'
$ALL_KEYS
KEYS_EOF"

    # Copy keys file to nested VM and install it
    # Try /etc/pve/priv/ first (PVE standard), fallback to ~/.ssh/
    pve_ssh "sshpass -p '$NESTED_PASSWORD' scp -o StrictHostKeyChecking=no /tmp/nested_keys.pub root@$NESTED_STATIC_IP:/tmp/"

    pve_ssh "sshpass -p '$NESTED_PASSWORD' ssh -o StrictHostKeyChecking=no root@$NESTED_STATIC_IP '
        # Try PVE standard location first
        if [ -d /etc/pve/priv ] || mkdir -p /etc/pve/priv 2>/dev/null; then
            cat /tmp/nested_keys.pub >> /etc/pve/priv/authorized_keys
            chmod 600 /etc/pve/priv/authorized_keys
            echo \"Keys installed to /etc/pve/priv/authorized_keys\"
        else
            # Fallback to standard SSH location
            mkdir -p ~/.ssh
            cat /tmp/nested_keys.pub >> ~/.ssh/authorized_keys
            chmod 600 ~/.ssh/authorized_keys
            echo \"Keys installed to ~/.ssh/authorized_keys (fallback)\"
        fi
        rm -f /tmp/nested_keys.pub
    '" || error "Failed to copy SSH keys"

    pve_ssh "rm -f /tmp/nested_keys.pub"
    success "SSH keys copied to nested VM"
else
    info "No SSH keys found to copy"
fi

# Verify SSH keys were actually copied (check both locations)
info "Verifying SSH keys..."
KEY_COUNT=$(pve_ssh "sshpass -p '$NESTED_PASSWORD' ssh -o StrictHostKeyChecking=no root@$NESTED_STATIC_IP '
    count=0
    [ -f /etc/pve/priv/authorized_keys ] && count=\$(cat /etc/pve/priv/authorized_keys | wc -l)
    [ \"\$count\" -eq 0 ] && [ -f ~/.ssh/authorized_keys ] && count=\$(cat ~/.ssh/authorized_keys | wc -l)
    echo \$count
'" 2>/dev/null)
if [ "$KEY_COUNT" -lt 1 ]; then
    error "SSH keys not found in authorized_keys (count: $KEY_COUNT)"
fi
success "Verified $KEY_COUNT SSH key(s) in authorized_keys"

# Sync filesystem to ensure keys are flushed to disk before snapshot
info "Syncing filesystem..."
pve_ssh "sshpass -p '$NESTED_PASSWORD' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@$NESTED_STATIC_IP 'sync'" || true
success "Filesystem synced"

NESTED_IP="$NESTED_STATIC_IP"
success "Nested VM IP: $NESTED_IP"

# Save IP for subsequent steps
echo "$NESTED_IP" > "$NESTED_IP_FILE"
info "IP saved to $NESTED_IP_FILE"

# Step 9: Verify Proxmox is running (via PVE host, not direct)
info "Verifying Proxmox VE installation..."
PVE_VERSION=$(pve_ssh "sshpass -p '$NESTED_PASSWORD' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@$NESTED_IP pveversion 2>/dev/null" || echo "unknown")

if [[ "$PVE_VERSION" == *"pve-manager"* ]]; then
    success "Proxmox VE verified: $PVE_VERSION"
else
    info "Could not verify Proxmox version (may need time to fully initialize)"
fi

# Step 10b: Create vmbr1 NAT bridge in nested VM for containers
header "Setting up Container NAT Bridge (vmbr1)"
info "Creating vmbr1 in nested VM for container networking..."

# Helper for nested SSH with timeout
nested_sshpass() {
    pve_ssh "sshpass -p '$NESTED_PASSWORD' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@$NESTED_STATIC_IP $*"
}

# Check if vmbr1 already exists
if nested_sshpass "ip link show vmbr1" &>/dev/null; then
    success "vmbr1 already exists"
else
    # Add vmbr1 configuration to nested VM
    nested_sshpass "'cat >> /etc/network/interfaces << EOF

auto vmbr1
iface vmbr1 inet static
    address 10.0.0.1
    netmask 255.255.255.0
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up echo 1 > /proc/sys/net/ipv6/conf/vmbr1/disable_ipv6
    post-up iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
EOF
'" || error "Failed to add vmbr1 configuration"

    # Bring up vmbr1
    nested_sshpass "ifup vmbr1" || error "Failed to bring up vmbr1"
    success "vmbr1 created with NAT (10.0.0.0/24)"
fi

# Step 11: Set up port forwarding on PVE host to nested VM
header "Setting up Port Forwarding (offset: $PORT_OFFSET)"
info "Configuring port forwarding on $PVE_HOST..."

# Configure all port forwarding in a single SSH call for efficiency
pve_ssh "
    # Enable IP forwarding
    echo 1 > /proc/sys/net/ipv4/ip_forward

    # Remove any existing forwarding rules for these ports
    iptables -t nat -D PREROUTING -p tcp --dport $PORT_PVE_WEB -j DNAT --to-destination $NESTED_IP:8006 2>/dev/null || true
    iptables -t nat -D PREROUTING -p tcp --dport $PORT_PVE_SSH -j DNAT --to-destination $NESTED_IP:22 2>/dev/null || true
    iptables -t nat -D PREROUTING -p tcp --dport $PORT_DEPLOYER -j DNAT --to-destination $NESTED_IP:3000 2>/dev/null || true
    iptables -D FORWARD -p tcp -d $NESTED_IP --dport 8006 -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -p tcp -d $NESTED_IP --dport 22 -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -p tcp -d $NESTED_IP --dport 3000 -j ACCEPT 2>/dev/null || true
    iptables -t nat -D POSTROUTING -s ${SUBNET}.0/24 -o vmbr0 -j MASQUERADE 2>/dev/null || true

    # Add port forwarding rules
    iptables -t nat -A PREROUTING -p tcp --dport $PORT_PVE_WEB -j DNAT --to-destination $NESTED_IP:8006
    iptables -A FORWARD -p tcp -d $NESTED_IP --dport 8006 -j ACCEPT
    iptables -t nat -A PREROUTING -p tcp --dport $PORT_PVE_SSH -j DNAT --to-destination $NESTED_IP:22
    iptables -A FORWARD -p tcp -d $NESTED_IP --dport 22 -j ACCEPT
    iptables -t nat -A PREROUTING -p tcp --dport $PORT_DEPLOYER -j DNAT --to-destination $NESTED_IP:3000
    iptables -A FORWARD -p tcp -d $NESTED_IP --dport 3000 -j ACCEPT

    # NAT for nested VM network
    iptables -t nat -A POSTROUTING -s ${SUBNET}.0/24 -o vmbr0 -j MASQUERADE
" || error "Failed to configure port forwarding"

success "Port $PORT_PVE_WEB -> $NESTED_IP:8006 (Web UI)"
success "Port $PORT_PVE_SSH -> $NESTED_IP:22 (SSH)"
success "Port $PORT_DEPLOYER -> $NESTED_IP:3000 (Deployer)"
success "NAT configured for ${SUBNET}.0/24"

# Step 11b: Install persistent port forwarding service
header "Installing Persistent Port Forwarding Service"
info "This ensures port forwarding survives reboots and snapshot rollbacks..."
PVE_HOST="$PVE_HOST" "$SCRIPT_DIR/scripts/setup-port-forwarding-service.sh"
success "Persistent port forwarding service installed"

# Step 12: Snapshot disabled - step1 only takes ~2 minutes, just re-run instead
# Snapshots caused GRUB boot issues after rollback, and are not worth the complexity
info "Snapshot creation disabled - re-run step1 for a fresh VM (~2 min)"

# Summary
header "Step 1 Complete"
echo -e "${GREEN}Nested Proxmox VM is ready!${NC}"
echo ""
echo "Instance: $E2E_INSTANCE"
echo ""
echo "VM Details:"
echo "  - VMID: $TEST_VMID"
echo "  - Name: $VM_NAME"
echo "  - IP Address: $NESTED_IP"
echo "  - Root Password: $NESTED_PASSWORD"
echo ""
echo "Network Configuration:"
echo "  - vmbr1 on $PVE_HOST: NAT network (${SUBNET}.0/24)"
echo "  - vmbr0 in nested VM: External network"
echo "  - vmbr1 in nested VM: NAT for containers (10.0.0.0/24)"
echo ""
echo "Port Forwarding (offset: $PORT_OFFSET):"
echo "  - $PVE_HOST:$PORT_PVE_SSH -> $NESTED_IP:22 (SSH)"
echo "  - $PVE_HOST:$PORT_PVE_WEB -> $NESTED_IP:8006 (Web UI)"
echo "  - $PVE_HOST:$PORT_DEPLOYER -> deployer:3000 (Deployer)"
echo ""
echo "Access:"
echo "  SSH:     ssh -p $PORT_PVE_SSH root@$PVE_HOST"
echo "  Web UI:  $PVE_WEB_URL"
echo ""
echo "Next steps:"
echo "  ./step2-install-deployer.sh $E2E_INSTANCE"
echo ""
