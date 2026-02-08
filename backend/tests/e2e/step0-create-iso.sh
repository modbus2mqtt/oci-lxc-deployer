#!/bin/bash
# step0-create-iso.sh - Creates custom Proxmox ISO for E2E testing
#
# This script runs on the DEVELOPMENT MACHINE and:
# 1. Connects to pve1.cluster via SSH
# 2. Copies necessary files to /tmp/e2e-iso-build/
# 3. Executes create-iso.sh on pve1 to build the ISO
# 4. ISO is placed at /var/lib/vz/template/iso/proxmox-ve-e2e-autoinstall.iso
#
# Usage:
#   ./step0-create-iso.sh              # Use default pve1.cluster
#   ./step0-create-iso.sh pve2.cluster # Use different host
#   PVE_HOST=pve2 ./step0-create-iso.sh

set -e

# Configuration
PVE_HOST="${PVE_HOST:-${1:-pve1.cluster}}"
WORK_DIR="/tmp/e2e-iso-build"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PVE1_SCRIPTS="$SCRIPT_DIR/pve1-scripts"

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

# SSH wrapper with standard options
pve_ssh() {
    ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 "root@$PVE_HOST" "$@"
}

pve_scp() {
    scp -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 "$@"
}

header "Step 0: Create Proxmox E2E Test ISO"
echo "Target Host: $PVE_HOST"
echo "Work Directory: $WORK_DIR"
echo "Script Source: $PVE1_SCRIPTS"
echo ""

# Step 1: Verify SSH connection
info "Checking SSH connection to $PVE_HOST..."
if ! pve_ssh "echo 'SSH OK'" &>/dev/null; then
    error "Cannot connect to $PVE_HOST via SSH. Please ensure:
  - SSH key is configured (ssh-copy-id root@$PVE_HOST)
  - Host is reachable
  - Hostname resolves correctly"
fi
success "SSH connection verified"

# Step 2: Verify we're connecting to a Proxmox host
info "Verifying Proxmox VE installation..."
PVE_VERSION=$(pve_ssh "pveversion 2>/dev/null || echo 'not-proxmox'")
if [[ "$PVE_VERSION" == "not-proxmox" ]]; then
    error "$PVE_HOST does not appear to be a Proxmox VE host"
fi
success "Proxmox VE detected: $PVE_VERSION"

# Step 3: Setup NAT network (vmbr1) for E2E test VMs
info "Checking NAT network (vmbr1) on $PVE_HOST..."
if pve_ssh "ip link show vmbr1" &>/dev/null; then
    success "NAT network vmbr1 already exists"
else
    info "Creating NAT network vmbr1 (10.99.0.0/24)..."

    # Get node name
    PVE_NODE=$(pve_ssh "hostname")

    # Create vmbr1 bridge via Proxmox API
    pve_ssh "pvesh create /nodes/$PVE_NODE/network \
        --iface vmbr1 \
        --type bridge \
        --address 10.99.0.1 \
        --netmask 255.255.255.0 \
        --autostart 1 \
        --comments 'NAT bridge for E2E test VMs'"

    # Apply network config
    pve_ssh "pvesh set /nodes/$PVE_NODE/network"
    sleep 2

    # Enable IP forwarding and NAT masquerading
    pve_ssh "
        echo 1 > /proc/sys/net/ipv4/ip_forward
        echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-e2e-nat.conf
        iptables -t nat -C POSTROUTING -s '10.99.0.0/24' -o vmbr0 -j MASQUERADE 2>/dev/null || \
        iptables -t nat -A POSTROUTING -s '10.99.0.0/24' -o vmbr0 -j MASQUERADE
    "

    # Make NAT rules persistent
    pve_ssh "cat > /etc/network/interfaces.d/e2e-nat << 'EOF'
# NAT rules for E2E test network (vmbr1)
post-up iptables -t nat -A POSTROUTING -s '10.99.0.0/24' -o vmbr0 -j MASQUERADE
post-down iptables -t nat -D POSTROUTING -s '10.99.0.0/24' -o vmbr0 -j MASQUERADE
EOF"

    success "NAT network vmbr1 created (10.99.0.0/24)"
fi

# Step 3b: Setup DHCP server on vmbr1
info "Checking DHCP server (dnsmasq) on vmbr1..."
if pve_ssh "test -f /etc/dnsmasq.d/vmbr1-dhcp.conf" &>/dev/null; then
    success "DHCP server already configured"
else
    info "Setting up DHCP server on vmbr1..."
    pve_ssh "
        # Install dnsmasq if needed
        which dnsmasq >/dev/null 2>&1 || apt-get install -y -qq dnsmasq

        # Configure DHCP for vmbr1
        cat > /etc/dnsmasq.d/vmbr1-dhcp.conf << 'EOF'
# DHCP for E2E test VMs on vmbr1
interface=vmbr1
bind-interfaces
dhcp-range=10.99.0.100,10.99.0.200,24h
dhcp-option=option:router,10.99.0.1
dhcp-option=option:dns-server,8.8.8.8,8.8.4.4
EOF

        # Restart dnsmasq
        systemctl enable dnsmasq
        systemctl restart dnsmasq
    "
    success "DHCP server configured on vmbr1 (10.99.0.100-200)"
fi

# Step 4: Check local files exist
info "Checking local script files..."
for file in answer-e2e.toml create-iso.sh first-boot.sh; do
    if [ ! -f "$PVE1_SCRIPTS/$file" ]; then
        error "Required file not found: $PVE1_SCRIPTS/$file"
    fi
done
success "All required files present"

# Step 4: Create work directory on pve1
info "Creating work directory on $PVE_HOST..."
pve_ssh "mkdir -p $WORK_DIR"
success "Work directory created: $WORK_DIR"

# Step 5: Copy files to pve1
info "Copying files to $PVE_HOST:$WORK_DIR/..."
pve_scp "$PVE1_SCRIPTS/answer-e2e.toml" "root@$PVE_HOST:$WORK_DIR/"
pve_scp "$PVE1_SCRIPTS/create-iso.sh" "root@$PVE_HOST:$WORK_DIR/"
pve_scp "$PVE1_SCRIPTS/first-boot.sh" "root@$PVE_HOST:$WORK_DIR/"

# Copy dev machine's SSH public key for direct access to nested VM
info "Copying dev machine SSH key..."
if [ -f ~/.ssh/id_ed25519.pub ]; then
    pve_scp ~/.ssh/id_ed25519.pub "root@$PVE_HOST:$WORK_DIR/dev_ssh_key.pub"
    success "Dev SSH key (ed25519) copied"
elif [ -f ~/.ssh/id_rsa.pub ]; then
    pve_scp ~/.ssh/id_rsa.pub "root@$PVE_HOST:$WORK_DIR/dev_ssh_key.pub"
    success "Dev SSH key (rsa) copied"
else
    info "No dev SSH key found - only pve1 will have access to nested VM"
fi

success "Files copied successfully"

# Step 6: Make scripts executable
info "Setting execute permissions..."
pve_ssh "chmod +x $WORK_DIR/*.sh"
success "Permissions set"

# Step 7: Execute create-iso.sh on pve1
header "Executing ISO creation on $PVE_HOST"
info "This may take a few minutes..."
echo ""

# Run the script and capture output
if pve_ssh "cd $WORK_DIR && ./create-iso.sh $WORK_DIR"; then
    echo ""
    header "ISO Creation Complete"
    success "Custom Proxmox ISO created successfully!"
    echo ""
    echo "ISO Location: $PVE_HOST:/var/lib/vz/template/iso/proxmox-ve-e2e-autoinstall.iso"
    echo ""
    echo "Next steps:"
    echo "  1. Run step1-create-vm.sh to create a test VM with this ISO"
    echo "  2. Or manually create a VM:"
    echo "     ssh root@$PVE_HOST"
    echo "     qm create 9000 --name pve-e2e-test --memory 4096 --cores 2 \\"
    echo "       --cpu host --net0 virtio,bridge=vmbr0 --scsi0 local-lvm:32 \\"
    echo "       --cdrom local:iso/proxmox-ve-e2e-autoinstall.iso --boot order=scsi0"
    echo ""
else
    error "ISO creation failed. Check the output above for details."
fi
