# Install lxc-manager on Proxmox

This guide installs the lxc-manager as an LXC container on a Proxmox host using the installer script hosted on GitHub.

## Requirements
- Proxmox VE host with shell access
- Proxmox VE needs Network connectivity to GitHub 

## Quick Install (IPv4)
Copy and run the following command on your Proxmox host (adjust IP addresses to your network):

```sh
curl -fsSL https://raw.githubusercontent.com/modbus2mqtt/lxc-manager/main/install-lxc-manager.sh \
  | sh -s -- --static-ip 192.168.4.100/24 --static-gw 192.168.4.1  # <- adjust IPs
```

- `--static-ip`: IPv4 address in CIDR notation (e.g., `192.168.4.100/24`)
- `--static-gw`: IPv4 gateway (e.g., `192.168.4.1`)

## IPv6 Example
Adjust IP addresses to your network:
```sh
curl -fsSL https://raw.githubusercontent.com/modbus2mqtt/lxc-manager/main/install-lxc-manager.sh \
  | sh -s -- --static-ip6 fd00::50/64 --static-gw6 fd00::1  # <- adjust IPs
```

## Advanced Options
You can override defaults:
- `--vm-id <id>`: Specific VMID; if omitted, the next free VMID is used.
- `--disk-size <GB>`: Root filesystem size in GB (default: `1`).
- `--memory <MB>`: Memory in MB (default: `256`).
- `--bridge <name>`: Network bridge (default: `vmbr0`).
- `--hostname <name>`: Hostname (default: `lxc-manager`).

Example with custom options:
```sh
curl -fsSL https://raw.githubusercontent.com/modbus2mqtt/lxc-manager/main/install-lxc-manager.sh \
  | sh -s -- --vm-id 102 --disk-size 4 --memory 512 --bridge vmbr0 --hostname lxc-manager \
    --static-ip 192.168.4.100/24 --static-gw 192.168.4.1
```

## What the script does
- Auto-selects the latest Alpine LXC template.
- Creates the container with the provided resources.
- Configures static IPv4/IPv6 networking when specified (CIDR validated).

## Access the Web UI
- Open `http://lxc-manager:3000` from your network (or use the container IP/hostname you configured).
- If Proxmox VE firewall is enabled, ensure port `3000/tcp` is allowed to the container/host.

## Troubleshooting
- If you get a CIDR format error, verify the IP notation (e.g., `192.168.4.100/24`).
- Ensure the Proxmox host can access GitHub raw content.
- Re-run with `--help` to see all available flags.
