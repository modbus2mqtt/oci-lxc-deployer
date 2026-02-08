# E2E Tests for oci-lxc-deployer

End-to-end tests that create a nested Proxmox VM and test the full deployment workflow.

## Prerequisites

- SSH access to a Proxmox VE host (e.g., `pve1.cluster`)
- SSH key authentication configured (`ssh-copy-id root@pve1.cluster`)
- Sufficient resources on the host (4GB RAM, 32GB disk for test VM)

## Quick Start

```bash
# Step 0: Create the custom Proxmox ISO
./step0-create-iso.sh pve1.cluster

# Step 1: Create and run the test VM (coming soon)
./step1-run-tests.sh pve1.cluster
```

## Files

```
backend/tests/e2e/
├── step0-create-iso.sh          # Main script - runs on dev machine
├── pve1-scripts/
│   ├── answer-e2e.toml          # Answer file for unattended Proxmox install
│   ├── create-iso.sh            # Runs on pve1 to build custom ISO
│   └── first-boot.sh            # First-boot script for apt repo config
└── README.md
```

## How It Works

### Step 0: Create Custom ISO

1. Connects to pve1.cluster via SSH
2. Copies answer file and scripts to `/tmp/e2e-iso-build/`
3. Downloads Proxmox ISO if not present
4. Uses `proxmox-auto-install-assistant` to create custom ISO
5. Places ISO at `/var/lib/vz/template/iso/proxmox-ve-e2e-autoinstall.iso`

The custom ISO includes:
- Answer file with DHCP networking, German keyboard/timezone
- SSH key from pve1 for passwordless access to nested VM
- First-boot script that configures apt repos for latest packages

### Step 1-8: Full E2E Test (Coming Soon)

Will test:
1. Create nested Proxmox VM from custom ISO
2. Wait for unattended installation
3. Install oci-lxc-deployer
4. Install Samba addon
5. Create Mosquitto via docker-compose
6. Upload config file
7. Verify MQTT connection
8. Cleanup

## Configuration

### answer-e2e.toml

Key settings:
- `root-password`: `e2e-test-2024`
- `fqdn`: `pve-e2e-nested.local`
- Network: DHCP
- Filesystem: ext4 on LVM
- Includes SSH key from pve1 for access

### first-boot.sh

Configures on first boot:
- Proxmox no-subscription repository
- Latest Debian repositories
- Installs jq, curl, netcat
- Enables QEMU guest agent
- **NAT network (vmbr1)** for container isolation:
  - Subnet: 10.0.0.0/24
  - DHCP: 10.0.0.100-200
  - DNS: dnsmasq with .e2e.local domain
  - Containers don't conflict with pve1's network

## Troubleshooting

### SSH connection fails

```bash
# Ensure SSH key is copied
ssh-copy-id root@pve1.cluster

# Test connection
ssh root@pve1.cluster "pveversion"
```

### ISO download fails

The script will try to use an existing Proxmox ISO from `/var/lib/vz/template/iso/`.
Manually download if needed:

```bash
# On pve1
cd /var/lib/vz/template/iso/
wget https://enterprise.proxmox.com/iso/proxmox-ve_8.3-1.iso
```

### proxmox-auto-install-assistant not found

```bash
# On pve1
apt-get update
apt-get install proxmox-auto-install-assistant
```
