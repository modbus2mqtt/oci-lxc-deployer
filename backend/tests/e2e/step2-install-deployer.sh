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
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NESTED_IP_FILE="$SCRIPT_DIR/.nested-vm-ip"

# PVE host for port forwarding (required for access from dev machine)
PVE_HOST="${PVE_HOST:-}"

# Host-specific network configuration
get_host_subnet() {
    local host="$1"
    case "$host" in
        *ubuntupve*) echo "10.99.1" ;;
        *pve1*)      echo "10.99.0" ;;
        *)           echo "10.99.0" ;;
    esac
}

# Get nested VM IP
if [ -n "$1" ]; then
    NESTED_IP="$1"
elif [ -f "$NESTED_IP_FILE" ]; then
    NESTED_IP=$(cat "$NESTED_IP_FILE")
elif [ -n "$PVE_HOST" ]; then
    SUBNET=$(get_host_subnet "$PVE_HOST")
    NESTED_IP="${SUBNET}.10"
else
    NESTED_IP="10.99.0.10"  # Default static IP
fi

# Owner settings for installation
# These override the defaults in the install script
OWNER="${OWNER:-volkmarnissen}"
OCI_OWNER="${OCI_OWNER:-volkmarnissen}"

# Deployer container settings
DEPLOYER_VMID="${DEPLOYER_VMID:-300}"

# Network bridge for deployer container (vmbr1 is the NAT network in nested VM)
DEPLOYER_BRIDGE="${DEPLOYER_BRIDGE:-vmbr1}"

# Static IP for deployer container (within nested VM's vmbr1 NAT network 10.0.0.0/24)
DEPLOYER_STATIC_IP="${DEPLOYER_STATIC_IP:-10.0.0.100/24}"
DEPLOYER_GATEWAY="${DEPLOYER_GATEWAY:-10.0.0.1}"

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
# Uses port forwarding via PVE_HOST if set, otherwise direct connection
# Uses /dev/null for known_hosts to avoid host key conflicts during E2E testing
nested_ssh() {
    if [ -n "$PVE_HOST" ]; then
        # Connect via port 1022 on PVE host
        ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -p 1022 "root@$PVE_HOST" "$@"
    else
        # Direct connection (when running on PVE host itself)
        ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 "root@$NESTED_IP" "$@"
    fi
}

header "Step 2: Install oci-lxc-deployer"
if [ -n "$PVE_HOST" ]; then
    echo "Connection: via $PVE_HOST:1022"
else
    echo "Connection: direct to $NESTED_IP"
fi
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
    DEPLOYER_STATUS=$(nested_ssh "pct status $DEPLOYER_VMID" | awk '/status:/ {print $2}')
    if [ "$DEPLOYER_STATUS" = "running" ]; then
        success "Deployer container is running"

        # Check if API is responding
        DEPLOYER_IP=$(nested_ssh "pct exec $DEPLOYER_VMID -- hostname -I 2>/dev/null" | awk '{print $1}')
        if [ -n "$DEPLOYER_IP" ]; then
            if nested_ssh "curl -s http://$DEPLOYER_IP:3000/ 2>/dev/null" | grep -q "doctype"; then
                success "API is healthy at $DEPLOYER_IP:3000"
                echo ""
                echo "Deployer already installed and running!"
                echo "API URL: http://$DEPLOYER_IP:3000"
                exit 0
            fi
        fi
    fi
fi

# Step 3: Clean up existing container and install oci-lxc-deployer
header "Installing oci-lxc-deployer"

# Clean up existing container if present
if nested_ssh "pct status $DEPLOYER_VMID" &>/dev/null; then
    info "Removing existing container $DEPLOYER_VMID..."
    nested_ssh "pct stop $DEPLOYER_VMID 2>/dev/null || true"
    sleep 2
    nested_ssh "pct unlock $DEPLOYER_VMID 2>/dev/null || true"
    nested_ssh "pct destroy $DEPLOYER_VMID --force --purge 2>/dev/null || true"
    success "Existing container removed"
fi

# Local script path on nested VM
LOCAL_SCRIPT_PATH="/tmp/oci-lxc-deployer-scripts"

# Copy local install script and json/ directory to nested VM for testing
LOCAL_INSTALL_SCRIPT="$PROJECT_ROOT/install-oci-lxc-deployer.sh"
LOCAL_JSON_DIR="$PROJECT_ROOT/json"
if [ -f "$LOCAL_INSTALL_SCRIPT" ] && [ -d "$LOCAL_JSON_DIR" ]; then
    info "Copying local install script to nested VM..."
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$LOCAL_INSTALL_SCRIPT" "root@$PVE_HOST:/tmp/install-oci-lxc-deployer.sh"
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "root@$PVE_HOST" "scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/install-oci-lxc-deployer.sh root@$NESTED_IP:/tmp/"
    success "Local install script copied"

    info "Copying local json/ directory to nested VM..."
    # Create tarball of json directory and copy it
    tar -czf /tmp/oci-lxc-deployer-json.tar.gz -C "$PROJECT_ROOT" json
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/oci-lxc-deployer-json.tar.gz "root@$PVE_HOST:/tmp/"
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "root@$PVE_HOST" "scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/oci-lxc-deployer-json.tar.gz root@$NESTED_IP:/tmp/"
    # Extract on nested VM
    nested_ssh "mkdir -p $LOCAL_SCRIPT_PATH && tar -xzf /tmp/oci-lxc-deployer-json.tar.gz -C $LOCAL_SCRIPT_PATH"
    rm -f /tmp/oci-lxc-deployer-json.tar.gz
    success "Local json/ directory copied to $LOCAL_SCRIPT_PATH"

    info "Running installation script with OWNER=$OWNER OCI_OWNER=$OCI_OWNER LOCAL_SCRIPT_PATH=$LOCAL_SCRIPT_PATH..."
    # Run local script with custom parameters and local scripts path
    nested_ssh "chmod +x /tmp/install-oci-lxc-deployer.sh && \
        OWNER=$OWNER OCI_OWNER=$OCI_OWNER LOCAL_SCRIPT_PATH=$LOCAL_SCRIPT_PATH /tmp/install-oci-lxc-deployer.sh --vm-id $DEPLOYER_VMID --bridge $DEPLOYER_BRIDGE --static-ip $DEPLOYER_STATIC_IP --gateway $DEPLOYER_GATEWAY"
else
    info "Running installation script from GitHub with OWNER=$OWNER OCI_OWNER=$OCI_OWNER..."
    # Fallback: Download and run from GitHub
    nested_ssh "curl -sSL https://raw.githubusercontent.com/$OWNER/oci-lxc-deployer/main/install-oci-lxc-deployer.sh | \
        OWNER=$OWNER OCI_OWNER=$OCI_OWNER bash -s -- --vm-id $DEPLOYER_VMID --bridge $DEPLOYER_BRIDGE --static-ip $DEPLOYER_STATIC_IP --gateway $DEPLOYER_GATEWAY"
fi

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

# Step 4b: Manually bring up container network interface
# Alpine containers with static IP sometimes don't auto-activate the interface
info "Activating container network interface..."
nested_ssh "pct exec $DEPLOYER_VMID -- ip link set eth0 up 2>/dev/null || true"
nested_ssh "pct exec $DEPLOYER_VMID -- ip addr add $DEPLOYER_STATIC_IP dev eth0 2>/dev/null || true"
nested_ssh "pct exec $DEPLOYER_VMID -- ip route add default via $DEPLOYER_GATEWAY 2>/dev/null || true"
sleep 2

# Verify network is up
if nested_ssh "pct exec $DEPLOYER_VMID -- ping -c 1 $DEPLOYER_GATEWAY" &>/dev/null; then
    success "Container network is up (gateway reachable)"
else
    info "Warning: Gateway not reachable, network may have issues"
fi

# Step 5: Use static IP and wait for API
# Extract IP without CIDR suffix
DEPLOYER_IP="${DEPLOYER_STATIC_IP%/*}"
info "Deployer static IP: $DEPLOYER_IP"
info "Waiting for API to be ready..."
sleep 5  # Give container time to initialize

for i in $(seq 1 60); do
    if nested_ssh "curl -s http://$DEPLOYER_IP:3000/ 2>/dev/null" | grep -q "doctype"; then
        success "API is healthy at $DEPLOYER_IP:3000"
        break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for API... %ds" $((i * 2))
    sleep 2
done

echo ""

# Step 5b: Set up port forwarding on nested VM to deployer container
header "Setting up Port Forwarding on Nested VM"
info "Configuring port forwarding to deployer container at $DEPLOYER_IP..."

# Remove any existing forwarding rules
nested_ssh "iptables -t nat -D PREROUTING -p tcp --dport 3000 -j DNAT --to-destination $DEPLOYER_IP:3000 2>/dev/null || true"
nested_ssh "iptables -D FORWARD -p tcp -d $DEPLOYER_IP --dport 3000 -j ACCEPT 2>/dev/null || true"

# Add port forwarding: nested_vm:3000 -> deployer:3000 (API/UI)
nested_ssh "iptables -t nat -A PREROUTING -p tcp --dport 3000 -j DNAT --to-destination $DEPLOYER_IP:3000"
nested_ssh "iptables -A FORWARD -p tcp -d $DEPLOYER_IP --dport 3000 -j ACCEPT"
success "Port 3000 -> $DEPLOYER_IP:3000 (API/UI)"

# Step 5c: Build and deploy local package (if LOCAL_PACKAGE is set or we're in the project directory)
if [ -f "$PROJECT_ROOT/package.json" ] && grep -q '"name": "oci-lxc-deployer"' "$PROJECT_ROOT/package.json"; then
    header "Deploying Local Package"
    info "Building local oci-lxc-deployer package..."

    cd "$PROJECT_ROOT"
    pnpm run build
    TARBALL=$(pnpm pack 2>&1 | grep -o 'oci-lxc-deployer-.*\.tgz')

    if [ -z "$TARBALL" ] || [ ! -f "$PROJECT_ROOT/$TARBALL" ]; then
        error "Failed to create package tarball"
    fi
    success "Created $TARBALL"

    # Copy tarball to nested VM first, then push to container
    info "Copying $TARBALL to nested VM..."
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P 1022 "$PROJECT_ROOT/$TARBALL" "root@$PVE_HOST:/tmp/"
    success "Package copied to nested VM"

    # Push tarball from nested VM to deployer container using pct push
    info "Pushing $TARBALL to deployer container..."
    nested_ssh "pct push $DEPLOYER_VMID /tmp/$TARBALL /tmp/$TARBALL"
    success "Package pushed to container"

    # Install the package globally using pct exec
    info "Installing package globally..."
    nested_ssh "pct exec $DEPLOYER_VMID -- sh -c 'cd /tmp && npm install -g $TARBALL'"
    success "Package installed globally"

    # Restart the container to load the new package
    info "Restarting deployer container..."
    nested_ssh "pct stop $DEPLOYER_VMID"
    sleep 3
    nested_ssh "pct start $DEPLOYER_VMID"
    sleep 5

    # Wait for API to come back up
    info "Waiting for API to restart..."
    for i in $(seq 1 30); do
        if nested_ssh "curl -s http://$DEPLOYER_IP:3000/ 2>/dev/null" | grep -q "doctype"; then
            success "API is healthy after package update"
            break
        fi
        sleep 2
    done

    # Cleanup
    rm -f "$PROJECT_ROOT/$TARBALL"
    nested_ssh "rm -f /tmp/$TARBALL"
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
echo "  - Web UI: http://$DEPLOYER_IP:3000"
echo ""
echo "Port Forwarding (from $PVE_HOST):"
echo "  - API/UI: $PVE_HOST:3000 -> $DEPLOYER_IP:3000"
echo ""
echo "Access from dev machine:"
echo "  - Web UI: http://$PVE_HOST:3000"
echo ""
echo "Installation from:"
echo "  - GitHub Owner: $OWNER"
echo "  - OCI Owner: $OCI_OWNER"
echo ""
echo "Next steps:"
echo "  1. Create baseline snapshot: CREATE_SNAPSHOT=1 ./step2-install-deployer.sh"
echo "  2. Run Playwright E2E tests"
echo ""
