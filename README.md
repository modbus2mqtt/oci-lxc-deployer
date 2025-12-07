<div align="center">

<img alt="LXC Manager Logo" src="docs/assets/lxc-manager-logo.svg" height="120" />

# LXC Manager

Install and manage common LXC applications on Proxmox (e.g., Home Assistant, Node-RED), with support for custom templates and extended application configurations.
</div>

## Quick Install
Run this on your Proxmox host **(adjust IP addresses to your network)**:

```sh
curl -fsSL https://raw.githubusercontent.com/modbus2mqtt/lxc-manager/main/install-lxc-manager.sh \
  | sh -s -- --static-ip 192.168.4.100/24 --static-gw 192.168.4.1  # <- adjust IPs
```

- `--static-ip`: IPv4 address in CIDR (e.g., `192.168.4.100/24`)
- `--static-gw`: IPv4 gateway (e.g., `192.168.4.1`)

For IPv6 **(adjust IP addresses to your network)**:
```sh
curl -fsSL https://raw.githubusercontent.com/modbus2mqtt/lxc-manager/main/install-lxc-manager.sh \
  | sh -s -- --static-ip6 fd00::50/64 --static-gw6 fd00::1  # <- adjust IPs
```

## Script Options
- `--vm-id <id>`: Specific VMID; if omitted, next free VMID is used
- `--disk-size <GB>`: Rootfs size (default: `1`)
- `--memory <MB>`: Memory (default: `256`)
- `--bridge <name>`: Network bridge (default: `vmbr0`)
- `--hostname <name>`: Hostname (default: `lxc-manager`)

## Access the Web UI
- Open `http://lxc-manager:3000` from your network (or replace `lxc-manager` with the container's IP/hostname you configured).
- If Proxmox VE is behind a firewall, ensure port `3000/tcp` is reachable from the browser.

## Documentation
See `docs/INSTALL.md` for full installation details, examples, and troubleshooting.


## Templates & Features
- Network helpers (e.g., static IP generation).
- Disk sharing and USB serial mapping templates.
- Parameterized tasks via JSON; validated against schemas in `backend/schemas/`.


## Why LXC Manager?
- Simple Web UI to install common apps (e.g., Home Assistant, Node-RED)
- Reusable JSON templates for repeatable provisioning
- Extend with your own templates and app configurations

