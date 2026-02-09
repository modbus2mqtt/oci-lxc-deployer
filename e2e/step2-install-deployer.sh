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
#   ./step2-install-deployer.sh                # Full install (creates container + snapshot)
#   ./step2-install-deployer.sh --update-only  # Fast update: build, deploy, restart (~15s)

set -e

# Parse arguments
UPDATE_ONLY=false
POSITIONAL_IP=""
for arg in "$@"; do
    case "$arg" in
        --update-only) UPDATE_ONLY=true ;;
        -*) ;; # Skip other flags
        *) POSITIONAL_IP="$arg" ;; # First non-flag is IP
    esac
done

# Configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NESTED_IP_FILE="$SCRIPT_DIR/.nested-vm-ip"

# Load environment from .env file if present
if [ -f "$SCRIPT_DIR/.env" ]; then
    # shellcheck disable=SC1091
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# PVE host for port forwarding (required for access from dev machine)
# Default: ubuntupve (connection via ssh -p 1022 root@ubuntupve)
PVE_HOST="${PVE_HOST:-ubuntupve}"

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
if [ -n "$POSITIONAL_IP" ]; then
    NESTED_IP="$POSITIONAL_IP"
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

# External URL for deployer (accessible from outside the NAT network)
DEPLOYER_URL="${DEPLOYER_URL:-http://${PVE_HOST}:3000}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Timing
SCRIPT_START=$(date +%s)
STEP_START=$SCRIPT_START

elapsed() {
    local now=$(date +%s)
    local total=$((now - SCRIPT_START))
    echo "${total}s"
}

step_elapsed() {
    local now=$(date +%s)
    local step=$((now - STEP_START))
    STEP_START=$now
    echo "${step}s"
}

info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1 ${CYAN}($(step_elapsed))${NC}"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }
header() {
    STEP_START=$(date +%s)
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"
}

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

                if [ "$UPDATE_ONLY" = "true" ]; then
                    info "--update-only: Skipping to local package deployment..."
                else
                    echo ""
                    echo "Deployer already installed and running!"
                    echo "API URL: http://$DEPLOYER_IP:3000"
                    echo ""
                    echo "To deploy updated code: ./step2-install-deployer.sh --update-only"
                    exit 0
                fi
            fi
        fi
    fi
fi

# Step 3: Clean up existing container and install oci-lxc-deployer (skip if --update-only)
if [ "$UPDATE_ONLY" != "true" ]; then
    header "Installing oci-lxc-deployer"

    # Clean up existing container if present
    if nested_ssh "pct status $DEPLOYER_VMID" &>/dev/null; then
        info "Removing existing container $DEPLOYER_VMID (force)..."
        nested_ssh "pct stop $DEPLOYER_VMID --skiplock 2>/dev/null || true; sleep 1; pct unlock $DEPLOYER_VMID 2>/dev/null || true; pct destroy $DEPLOYER_VMID --force --purge 2>/dev/null || true"
        success "Existing container removed"
    fi

# Local script path on nested VM
LOCAL_SCRIPT_PATH="/tmp/oci-lxc-deployer-scripts"

# Copy local install script and shared scripts to nested VM for testing
LOCAL_INSTALL_SCRIPT="$PROJECT_ROOT/install-oci-lxc-deployer.sh"
LOCAL_SHARED_SCRIPTS="$PROJECT_ROOT/json/shared/scripts"
if [ -f "$LOCAL_INSTALL_SCRIPT" ] && [ -d "$LOCAL_SHARED_SCRIPTS" ]; then
    info "Copying local install script to nested VM..."
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$LOCAL_INSTALL_SCRIPT" "root@$PVE_HOST:/tmp/install-oci-lxc-deployer.sh" || error "Failed to copy install script to PVE host"
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "root@$PVE_HOST" "scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/install-oci-lxc-deployer.sh root@$NESTED_IP:/tmp/" || error "Failed to copy install script to nested VM"
    success "Local install script copied"

    info "Copying local shared scripts to nested VM..."
    # Create tarball of only json/shared/scripts (what install script needs)
    tar -czf /tmp/oci-lxc-deployer-scripts.tar.gz -C "$PROJECT_ROOT" json/shared/scripts || error "Failed to create scripts tarball"
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/oci-lxc-deployer-scripts.tar.gz "root@$PVE_HOST:/tmp/" || error "Failed to copy scripts tarball to PVE host"
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "root@$PVE_HOST" "scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/oci-lxc-deployer-scripts.tar.gz root@$NESTED_IP:/tmp/" || error "Failed to copy scripts tarball to nested VM"
    # Extract on nested VM
    nested_ssh "mkdir -p $LOCAL_SCRIPT_PATH && tar -xzf /tmp/oci-lxc-deployer-scripts.tar.gz -C $LOCAL_SCRIPT_PATH" || error "Failed to extract scripts on nested VM"
    rm -f /tmp/oci-lxc-deployer-scripts.tar.gz
    success "Local shared scripts copied to $LOCAL_SCRIPT_PATH"

    info "Running installation script with OWNER=$OWNER OCI_OWNER=$OCI_OWNER LOCAL_SCRIPT_PATH=$LOCAL_SCRIPT_PATH..."
    # Run local script with custom parameters and local scripts path
    nested_ssh "chmod +x /tmp/install-oci-lxc-deployer.sh && \
        OWNER=$OWNER OCI_OWNER=$OCI_OWNER LOCAL_SCRIPT_PATH=$LOCAL_SCRIPT_PATH /tmp/install-oci-lxc-deployer.sh --vm-id $DEPLOYER_VMID --bridge $DEPLOYER_BRIDGE --static-ip $DEPLOYER_STATIC_IP --gateway $DEPLOYER_GATEWAY --deployer-url $DEPLOYER_URL" || error "Installation script failed"
else
    info "Running installation script from GitHub with OWNER=$OWNER OCI_OWNER=$OCI_OWNER..."
    # Fallback: Download and run from GitHub
    nested_ssh "curl -sSL https://raw.githubusercontent.com/$OWNER/oci-lxc-deployer/main/install-oci-lxc-deployer.sh | \
        OWNER=$OWNER OCI_OWNER=$OCI_OWNER bash -s -- --vm-id $DEPLOYER_VMID --bridge $DEPLOYER_BRIDGE --static-ip $DEPLOYER_STATIC_IP --gateway $DEPLOYER_GATEWAY --deployer-url $DEPLOYER_URL" || error "Installation script from GitHub failed"
fi

success "Installation script completed"

# Step 4: Wait for container to be running (max 30s)
info "Waiting for deployer container to start..."
CONTAINER_STARTED=false
for i in $(seq 1 30); do
    if nested_ssh "pct status $DEPLOYER_VMID 2>/dev/null" | grep -q "running"; then
        success "Deployer container is running"
        CONTAINER_STARTED=true
        break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for container... %ds" "$i"
    sleep 1
done
echo ""
if [ "$CONTAINER_STARTED" != "true" ]; then
    error "Container $DEPLOYER_VMID failed to start within 30 seconds"
fi

# Step 4b: Manually bring up container network interfaces
# Alpine containers with static IP sometimes don't auto-activate the interfaces
info "Activating container network interfaces..."
nested_ssh "pct exec $DEPLOYER_VMID -- sh -c 'ip link set lo up; ip link set eth0 up; ip addr add $DEPLOYER_STATIC_IP dev eth0 2>/dev/null; ip route add default via $DEPLOYER_GATEWAY 2>/dev/null' || true"
sleep 1

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
info "Waiting for API to be ready (max 30s)..."
sleep 1  # Brief pause for container init

API_READY=false
for i in $(seq 1 30); do
    if nested_ssh "curl -s --connect-timeout 1 http://$DEPLOYER_IP:3000/ 2>/dev/null" | grep -q "doctype"; then
        success "API is healthy at $DEPLOYER_IP:3000"
        API_READY=true
        break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for API... %ds" "$i"
    sleep 1
done
echo ""
if [ "$API_READY" != "true" ]; then
    error "API failed to respond within 30 seconds at $DEPLOYER_IP:3000"
fi

fi # end of full install block (skipped with --update-only)

# Ensure DEPLOYER_IP is set (needed for port forwarding and package deployment)
DEPLOYER_IP="${DEPLOYER_STATIC_IP%/*}"

# In --update-only mode, ensure container network is up (might be down after restart)
if [ "$UPDATE_ONLY" = "true" ]; then
    info "Ensuring container network is up..."
    nested_ssh "pct exec $DEPLOYER_VMID -- sh -c 'ip link set lo up; ip link set eth0 up; ip addr add $DEPLOYER_STATIC_IP dev eth0 2>/dev/null; ip route add default via $DEPLOYER_GATEWAY 2>/dev/null' || true"
    if nested_ssh "pct exec $DEPLOYER_VMID -- ping -c 1 1.1.1.1" &>/dev/null; then
        success "Container network is up"
    else
        error "Container network failed - cannot reach internet"
    fi
fi

# Step 5b: Set up port forwarding on nested VM to deployer container
header "Setting up Port Forwarding on Nested VM"
info "Configuring port forwarding to deployer container at $DEPLOYER_IP..."

# Configure port forwarding in single SSH call
nested_ssh "
  iptables -t nat -D PREROUTING -p tcp --dport 3000 -j DNAT --to-destination $DEPLOYER_IP:3000 2>/dev/null || true
  iptables -D FORWARD -p tcp -d $DEPLOYER_IP --dport 3000 -j ACCEPT 2>/dev/null || true
  iptables -t nat -A PREROUTING -p tcp --dport 3000 -j DNAT --to-destination $DEPLOYER_IP:3000
  iptables -A FORWARD -p tcp -d $DEPLOYER_IP --dport 3000 -j ACCEPT
"
success "Port 3000 -> $DEPLOYER_IP:3000 (API/UI)"

# Step 5c: Build and deploy local package (if LOCAL_PACKAGE is set or we're in the project directory)
if [ -f "$PROJECT_ROOT/package.json" ] && grep -q '"name": "oci-lxc-deployer"' "$PROJECT_ROOT/package.json"; then
    header "Deploying Local Package"
    cd "$PROJECT_ROOT"

    info "Building local oci-lxc-deployer package..."
    pnpm run build || error "Failed to build package"

    TARBALL=$(pnpm pack 2>&1 | grep -o 'oci-lxc-deployer-.*\.tgz')

    if [ -z "$TARBALL" ] || [ ! -f "$PROJECT_ROOT/$TARBALL" ]; then
        error "Failed to create package tarball"
    fi
    success "Created $TARBALL"

    # Copy tarball to nested VM first, then push to container
    info "Copying $TARBALL to nested VM..."
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P 1022 "$PROJECT_ROOT/$TARBALL" "root@$PVE_HOST:/tmp/" || error "Failed to copy tarball to nested VM"
    success "Package copied to nested VM"

    # Push tarball from nested VM to deployer container using pct push
    info "Pushing $TARBALL to deployer container..."
    nested_ssh "pct push $DEPLOYER_VMID /tmp/$TARBALL /tmp/$TARBALL" || error "Failed to push tarball to container"
    success "Package pushed to container"

    # Verify network before package install
    info "Verifying container network..."
    if ! nested_ssh "pct exec $DEPLOYER_VMID -- ping -c 1 -W 2 1.1.1.1" &>/dev/null; then
        error "Container has no network - cannot install packages"
    fi
    success "Network verified"

    if [ "$UPDATE_ONLY" = "true" ]; then
        # Fast path: Extract and update package directly (skips dependency resolution)
        info "Updating package files directly..."
        nested_ssh "pct exec $DEPLOYER_VMID -- sh -c '
            cd /tmp && tar -xzf $TARBALL && \
            rm -rf /usr/local/lib/node_modules/oci-lxc-deployer/backend/dist && \
            rm -rf /usr/local/lib/node_modules/oci-lxc-deployer/frontend/dist && \
            cp -r package/backend/dist /usr/local/lib/node_modules/oci-lxc-deployer/backend/ && \
            cp -r package/frontend/dist /usr/local/lib/node_modules/oci-lxc-deployer/frontend/ && \
            rm -rf package
        '" || error "Failed to update package files"
        success "Package updated"
    else
        # Full install: Use npm install (needed for fresh container)
        info "Installing package globally with npm..."
        nested_ssh "pct exec $DEPLOYER_VMID -- sh -c 'npm install -g --cache /tmp/npm-cache --no-audit --no-fund --ignore-scripts /tmp/$TARBALL'" || error "Failed to install package globally"
        success "Package installed globally"
    fi

    # Restart container to reload the updated code (PID 1 is oci-lxc-deployer)
    info "Restarting container..."
    nested_ssh "pct stop $DEPLOYER_VMID && sleep 1 && pct start $DEPLOYER_VMID" || error "Failed to restart container"
    sleep 2
    # Re-activate network after restart
    nested_ssh "pct exec $DEPLOYER_VMID -- sh -c 'ip link set lo up; ip link set eth0 up; ip addr add $DEPLOYER_STATIC_IP dev eth0 2>/dev/null; ip route add default via $DEPLOYER_GATEWAY 2>/dev/null' || true"
    success "Container restarted"

    # Wait for API to come back up (max 20s)
    info "Waiting for API to restart..."
    API_RESTARTED=false
    for i in $(seq 1 20); do
        if nested_ssh "curl -s --connect-timeout 1 http://$DEPLOYER_IP:3000/ 2>/dev/null" | grep -q "doctype"; then
            success "API is healthy after package update"
            API_RESTARTED=true
            break
        fi
        printf "\r${YELLOW}[INFO]${NC} Waiting for API restart... %ds" "$i"
        sleep 1
    done
    echo ""
    if [ "$API_RESTARTED" != "true" ]; then
        error "API failed to restart within 20 seconds"
    fi

    # Cleanup
    rm -f "$PROJECT_ROOT/$TARBALL"
    nested_ssh "rm -f /tmp/$TARBALL"
fi

# Step 6: Create snapshot (only for full install, not for --update-only)
if [ "$UPDATE_ONLY" != "true" ]; then
    header "Creating Snapshot"
    NESTED_VMID="${TEST_VMID:-9000}"

    info "Deleting existing snapshot 'deployer-installed' if present..."
    PVE_HOST="$PVE_HOST" "$SCRIPT_DIR/scripts/snapshot-delete.sh" "$NESTED_VMID" "deployer-installed" 2>/dev/null || true

    info "Creating snapshot 'deployer-installed' of nested VM..."
    PVE_HOST="$PVE_HOST" "$SCRIPT_DIR/scripts/snapshot-create.sh" "$NESTED_VMID" "deployer-installed" || error "Failed to create snapshot"
    success "Snapshot 'deployer-installed' created"
fi

# Summary
TOTAL_TIME=$(elapsed)
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
if [ "$UPDATE_ONLY" = "true" ]; then
    echo -e "${GREEN}  Code deployed in ${TOTAL_TIME}${NC}"
else
    echo -e "${GREEN}  Step 2 Complete in ${TOTAL_TIME}${NC}"
fi
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "API URL: http://$PVE_HOST:3000"
echo ""
if [ "$UPDATE_ONLY" != "true" ]; then
    echo "Quick update: ./step2-install-deployer.sh --update-only"
fi
