#!/bin/bash
# create-iso.sh - Creates custom Proxmox ISO for E2E testing
# This script runs ON pve1.cluster
#
# Usage: ./create-iso.sh [WORK_DIR]

set -e

WORK_DIR="${1:-/tmp/e2e-iso-build}"
ISO_DIR="/var/lib/vz/template/iso"
# Instance name is passed as second argument (from step0)
E2E_INSTANCE="${2:-}"
if [ -n "$E2E_INSTANCE" ]; then
    OUTPUT_ISO="proxmox-ve-e2e-${E2E_INSTANCE}.iso"
else
    OUTPUT_ISO="proxmox-ve-e2e-autoinstall.iso"
fi

# Proxmox ISO version to use (update as needed)
# Use version 9.1 to match pve1.cluster
PVE_VERSION="9.1-1"
# Official free download URL (not enterprise)
PVE_ISO_URL="http://download.proxmox.com/iso/proxmox-ve_${PVE_VERSION}.iso"
PVE_ISO_FILE="proxmox-ve_${PVE_VERSION}.iso"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

# Check we're running on Proxmox
if ! command -v pveversion &> /dev/null; then
    error "This script must run on a Proxmox VE host"
fi

info "Working directory: $WORK_DIR"
cd "$WORK_DIR"

# Step 1: Install proxmox-auto-install-assistant if needed
if ! command -v proxmox-auto-install-assistant &> /dev/null; then
    info "Installing proxmox-auto-install-assistant..."
    apt-get update -qq
    apt-get install -y -qq proxmox-auto-install-assistant
    success "proxmox-auto-install-assistant installed"
else
    success "proxmox-auto-install-assistant already installed"
fi

# Step 2: Download Proxmox ISO if not present
# IMPORTANT: We need the EXACT version, not just any ISO
if [ -f "$ISO_DIR/$PVE_ISO_FILE" ]; then
    # Exact version exists in template directory - copy to work dir
    info "Copying cached ISO from $ISO_DIR..."
    cp "$ISO_DIR/$PVE_ISO_FILE" "$WORK_DIR/$PVE_ISO_FILE"
    success "ISO copied: $PVE_ISO_FILE"
elif [ -f "$WORK_DIR/$PVE_ISO_FILE" ]; then
    # Already in work directory
    success "Proxmox ISO already in work directory: $PVE_ISO_FILE"
else
    # Need to download - existing ISOs with different versions won't work
    if ls "$ISO_DIR"/proxmox-ve_*.iso 1> /dev/null 2>&1; then
        info "Note: Found other ISO versions in $ISO_DIR, but need exact version $PVE_VERSION"
    fi

    info "Downloading Proxmox VE $PVE_VERSION ISO..."
    info "URL: $PVE_ISO_URL"
    info "This may take a while (ISO is ~1.8GB)..."

    # Download from official Proxmox download server
    # Quiet mode - no progress (avoids line spam over SSH)
    if wget -q -O "$PVE_ISO_FILE" "$PVE_ISO_URL"; then
        success "Proxmox ISO downloaded"
        # Save to template directory for future runs
        cp "$PVE_ISO_FILE" "$ISO_DIR/$PVE_ISO_FILE"
        info "ISO cached at $ISO_DIR/$PVE_ISO_FILE"
    else
        error "Could not download Proxmox ISO from $PVE_ISO_URL
Please download manually:
  wget -O /var/lib/vz/template/iso/$PVE_ISO_FILE $PVE_ISO_URL"
    fi
fi

# Step 3: Get SSH public keys for the answer file
info "Retrieving SSH public keys for answer file..."

# Get pve1's SSH key
if [ -f /root/.ssh/id_ed25519.pub ]; then
    PVE1_SSH_KEY=$(cat /root/.ssh/id_ed25519.pub)
elif [ -f /root/.ssh/id_rsa.pub ]; then
    PVE1_SSH_KEY=$(cat /root/.ssh/id_rsa.pub)
else
    # Generate SSH key if none exists
    info "No SSH key found on pve1, generating new ed25519 key..."
    ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q
    PVE1_SSH_KEY=$(cat /root/.ssh/id_ed25519.pub)
fi
success "pve1 SSH key: ${PVE1_SSH_KEY:0:50}..."

# Get dev machine SSH key (passed as file from step0)
if [ -f "$WORK_DIR/dev_ssh_key.pub" ]; then
    DEV_SSH_KEY=$(cat "$WORK_DIR/dev_ssh_key.pub")
    success "Dev SSH key: ${DEV_SSH_KEY:0:50}..."
else
    info "No dev SSH key provided, only pve1 will have access"
    DEV_SSH_KEY=""
fi

# Step 4: Update answer file with actual SSH keys
info "Configuring answer file with SSH keys..."
if [ ! -f "answer-e2e.toml" ]; then
    error "answer-e2e.toml not found in $WORK_DIR"
fi

# Escape the SSH keys for sed (handle special characters)
PVE1_KEY_ESCAPED=$(printf '%s\n' "$PVE1_SSH_KEY" | sed 's/[&/\]/\\&/g')
sed -i "s|PLACEHOLDER_PVE1_SSH_KEY|$PVE1_KEY_ESCAPED|g" answer-e2e.toml

if [ -n "$DEV_SSH_KEY" ]; then
    DEV_KEY_ESCAPED=$(printf '%s\n' "$DEV_SSH_KEY" | sed 's/[&/\]/\\&/g')
    sed -i "s|PLACEHOLDER_DEV_SSH_KEY|$DEV_KEY_ESCAPED|g" answer-e2e.toml
else
    # Remove the dev key placeholder line if no dev key provided
    sed -i '/PLACEHOLDER_DEV_SSH_KEY/d' answer-e2e.toml
fi
success "Answer file configured with SSH keys"

# Step 5: Create the custom ISO
info "Creating custom ISO with embedded answer file..."

# Check if first-boot script exists and include it
EXTRA_ARGS=""
if [ -f "first-boot.sh" ]; then
    info "Including first-boot script..."
    chmod +x first-boot.sh
    EXTRA_ARGS="--on-first-boot first-boot.sh"
fi

# Create the auto-install ISO
proxmox-auto-install-assistant prepare-iso \
    "$PVE_ISO_FILE" \
    --fetch-from iso \
    --answer-file answer-e2e.toml \
    $EXTRA_ARGS \
    --output "$OUTPUT_ISO"

# Find the created ISO (tool may use different naming)
CREATED_ISO=""
if [ -f "$OUTPUT_ISO" ]; then
    CREATED_ISO="$OUTPUT_ISO"
elif [ -f "${PVE_ISO_FILE%.iso}-auto.iso" ]; then
    # Tool sometimes appends "-auto" to input filename
    CREATED_ISO="${PVE_ISO_FILE%.iso}-auto.iso"
else
    # Search for any recently created ISO
    CREATED_ISO=$(ls -t *.iso 2>/dev/null | grep -v "^$PVE_ISO_FILE$" | head -1)
fi

if [ -z "$CREATED_ISO" ] || [ ! -f "$CREATED_ISO" ]; then
    error "ISO creation failed - no output file found. Check proxmox-auto-install-assistant output above."
fi

success "Custom ISO created: $CREATED_ISO"

# Step 6: Move ISO to template directory
info "Moving ISO to $ISO_DIR..."
mv -f "$CREATED_ISO" "$ISO_DIR/$OUTPUT_ISO"
success "ISO available at: $ISO_DIR/$OUTPUT_ISO"

# Step 7: Cleanup work files (keep originals)
info "Cleaning up temporary files..."
rm -f "$WORK_DIR/$PVE_ISO_FILE"

echo ""
echo "=============================================="
echo -e "${GREEN}ISO creation successful!${NC}"
echo "=============================================="
echo ""
echo "ISO location: $ISO_DIR/$OUTPUT_ISO"
echo ""
echo "To create a VM with this ISO:"
echo "  qm create 9000 \\"
echo "    --name pve-e2e-test \\"
echo "    --memory 4096 \\"
echo "    --cores 2 \\"
echo "    --cpu host \\"
echo "    --net0 virtio,bridge=vmbr0 \\"
echo "    --scsi0 local-lvm:32 \\"
echo "    --cdrom local:iso/$OUTPUT_ISO \\"
echo "    --boot order=scsi0"
echo ""
