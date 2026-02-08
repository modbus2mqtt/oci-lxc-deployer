# E2E Testing with Proxmox VM

## Goal

End-to-end testing with automated VM creation, oci-lxc-deployer installation, and Mosquitto deployment via docker-compose.

## Test Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Development Machine                                                    │
│  └── SSH → pve1.cluster                                                 │
│           └── Step 0: Create custom Proxmox ISO with answer file        │
│           └── Step 1: Create VM (QEMU) with Proxmox ISO                 │
│           └── Step 2: Wait for unattended Proxmox installation          │
│           └── Step 3: Install oci-lxc-deployer                          │
│           └── Step 4: Install Samba addon for local directory           │
│           └── Step 5: Create Mosquitto via docker-compose.yml           │
│           └── Step 6: Upload configuration file                         │
│           └── Step 7: Verify MQTT connection + config                   │
│           └── Step 8: Delete VM                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Step 0: Create Custom Proxmox ISO

Creates a Proxmox ISO with embedded answer file for unattended installation.

### Usage

```bash
# From development machine
./backend/tests/e2e/step0-create-iso.sh pve1.cluster

# The script will:
# 1. Copy necessary files to pve1:/tmp/e2e-iso-build/
# 2. Download Proxmox ISO if not present
# 3. Create answer file with correct apt repository URLs
# 4. Build custom ISO with proxmox-auto-install-assistant
# 5. Move ISO to /var/lib/vz/template/iso/ for easy installation
```

### Files

```
backend/tests/e2e/
├── step0-create-iso.sh          # Main script (runs on dev machine)
├── pve1-scripts/
│   ├── answer-e2e.toml          # Answer file with apt repos + SSH key
│   ├── create-iso.sh            # Runs on pve1 to build ISO
│   └── first-boot.sh            # Configures apt repos on first boot
└── README.md
```

### Answer File Configuration

- **Network**: DHCP
- **Keyboard/Timezone**: German (de)
- **Filesystem**: ext4 on LVM
- **Root Password**: `e2e-test-2024`
- **SSH Keys**: Automatically includes pve1's SSH key
- **First Boot**: Configures Proxmox no-subscription repo

### Result

ISO at `/var/lib/vz/template/iso/proxmox-ve-e2e-autoinstall.iso`

---

## Step 1-8: Full E2E Test (Planned)

### Prerequisites

- Custom ISO created by Step 0
- SSH access to pve1.cluster

### Test Cases

| Step | Description | Verification |
|------|-------------|--------------|
| 1 | Create nested Proxmox VM | VM running |
| 2 | Wait for Proxmox installation | SSH accessible |
| 3 | Install oci-lxc-deployer | Container running |
| 4 | Install Samba addon | smbd service active |
| 5 | Create Mosquitto via docker-compose | Container running |
| 6 | Upload mosquitto.conf | File exists |
| 7 | Verify MQTT | Port 1883 open, config applied |
| 8 | Cleanup | VM deleted |

---

## Future: GitHub Runner Integration

A GitHub Actions self-hosted runner can be installed as LXC container on pve1.cluster:

```bash
# Create LXC for runner
pct create 200 local:vztmpl/debian-12-standard_12.0-1_amd64.tar.zst \
  --hostname github-runner \
  --memory 2048 \
  --cores 2 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp

# Install runner inside container
# See backend/tests/e2e/README.md for details
```

---

## References

- [Proxmox Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)
- [proxmox-auto-install-assistant](https://pve.proxmox.com/wiki/Automated_Installation#Assistant_Tool)
