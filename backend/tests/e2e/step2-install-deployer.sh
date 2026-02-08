#!/bin/bash
# step2-install-deployer.sh - Installs oci-lxc-deployer for E2E testing
#
# This script:
# 1. Connects to the nested Proxmox VM
# 2. Installs oci-lxc-deployer with custom OWNER settings
# 3. Waits for the API to be ready
# 4. Optionally creates a baseline snapshot
#
# Usage:
#   ./step2-install-deployer.sh                          # Use saved nested VM IP
#   ./step2-install-deployer.sh 10.99.0.10              # Specify IP directly
#   OWNER=myuser OCI_OWNER=myoci ./step2-install-deployer.sh  # Custom owners
#   CREATE_SNAPSHOT=1 ./step2-install-deployer.sh       # Create baseline snapshot after install

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NESTED_IP_FILE="$SCRIPT_DIR/.nested-vm-ip"

# Get nested VM IP
if [ -n "$1" ]; then
    NESTED_IP="$1"
elif [ -f "$NESTED_IP_FILE" ]; then
    NESTED_IP=$(cat "$NESTED_IP_FILE")
else
    NESTED_IP="10.99.0.10"  # Default static IP
fi

# Owner settings for installation
# These override the defaults in the install script
OWNER="${OWNER:-volkmarnissen}"
OCI_OWNER="${OCI_OWNER:-volkmarnissen}"

# Deployer container settings
DEPLOYER_VMID="${DEPLOYER_VMID:-300}"

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

# SSH wrapper for nested VM
nested_ssh() {
    ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 "root@$NESTED_IP" "$@"
}

header "Step 2: Install oci-lxc-deployer"
echo "Nested VM IP: $NESTED_IP"
echo "Owner: $OWNER"
echo "OCI Owner: $OCI_OWNER"
echo "Deployer VMID: $DEPLOYER_VMID"
echo ""

# Step 1: Check SSH connection
info "Checking SSH connection to $NESTED_IP..."
if ! nested_ssh "echo 'SSH OK'" &>/dev/null; then
    error "Cannot connect to $NESTED_IP via SSH. Is the nested VM running?"
fi
success "SSH connection verified"

# Step 2: Check if deployer already exists
if nested_ssh "pct status $DEPLOYER_VMID" &>/dev/null; then
    info "Deployer container $DEPLOYER_VMID already exists"
    DEPLOYER_STATUS=$(nested_ssh "pct status $DEPLOYER_VMID" | grep -oP 'status: \K\w+')
    if [ "$DEPLOYER_STATUS" = "running" ]; then
        success "Deployer container is running"

        # Check if API is responding
        DEPLOYER_IP=$(nested_ssh "pct exec $DEPLOYER_VMID -- hostname -I 2>/dev/null" | awk '{print $1}')
        if [ -n "$DEPLOYER_IP" ]; then
            if nested_ssh "curl -s http://$DEPLOYER_IP:3000/api/health 2>/dev/null" | grep -q "ok"; then
                success "API is healthy at $DEPLOYER_IP:3000"
                echo ""
                echo "Deployer already installed and running!"
                echo "API URL: http://$DEPLOYER_IP:3000"
                exit 0
            fi
        fi
    fi
fi

# Step 3: Install oci-lxc-deployer
header "Installing oci-lxc-deployer"
info "Running installation script with OWNER=$OWNER OCI_OWNER=$OCI_OWNER..."

# Download and run the install script with custom parameters
nested_ssh "curl -sSL https://raw.githubusercontent.com/$OWNER/oci-lxc-deployer/main/install-oci-lxc-deployer.sh | \
    OWNER=$OWNER OCI_OWNER=$OCI_OWNER bash -s -- --vm-id $DEPLOYER_VMID"

success "Installation script completed"

# Step 4: Wait for container to be running
info "Waiting for deployer container to start..."
for i in $(seq 1 60); do
    if nested_ssh "pct status $DEPLOYER_VMID 2>/dev/null" | grep -q "running"; then
        success "Deployer container is running"
        break
    fi
    sleep 2
done

# Step 5: Get deployer IP and wait for API
info "Waiting for API to be ready..."
sleep 10  # Give container time to initialize

for i in $(seq 1 60); do
    DEPLOYER_IP=$(nested_ssh "pct exec $DEPLOYER_VMID -- hostname -I 2>/dev/null" | awk '{print $1}')
    if [ -n "$DEPLOYER_IP" ]; then
        if nested_ssh "curl -s http://$DEPLOYER_IP:3000/api/health 2>/dev/null" | grep -q "ok"; then
            success "API is healthy at $DEPLOYER_IP:3000"
            break
        fi
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for API... %ds" $((i * 2))
    sleep 2
done

echo ""

if [ -z "$DEPLOYER_IP" ]; then
    error "Could not get deployer IP address"
fi

# Step 6: Create baseline snapshot if requested
if [ -n "$CREATE_SNAPSHOT" ]; then
    header "Creating Baseline Snapshot"
    info "Creating snapshot 'e2e-baseline' of deployer container..."

    # Stop container for clean snapshot
    nested_ssh "pct stop $DEPLOYER_VMID" || true
    sleep 2

    # Create snapshot
    nested_ssh "pct snapshot $DEPLOYER_VMID e2e-baseline --description 'Clean oci-lxc-deployer installation'"

    # Start container again
    nested_ssh "pct start $DEPLOYER_VMID"
    sleep 5

    success "Snapshot 'e2e-baseline' created"
fi

# Summary
header "Step 2 Complete"
echo -e "${GREEN}oci-lxc-deployer is installed and running!${NC}"
echo ""
echo "Deployer Details:"
echo "  - Container VMID: $DEPLOYER_VMID"
echo "  - Container IP: $DEPLOYER_IP"
echo "  - API URL: http://$DEPLOYER_IP:3000"
echo "  - Web UI: http://$DEPLOYER_IP:4200"
echo ""
echo "Installation from:"
echo "  - GitHub Owner: $OWNER"
echo "  - OCI Owner: $OCI_OWNER"
echo ""
echo "Next steps:"
echo "  1. Create baseline snapshot: CREATE_SNAPSHOT=1 ./step2-install-deployer.sh"
echo "  2. Run Playwright E2E tests"
echo ""
