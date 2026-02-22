# Mosquitto

Mosquitto MQTT broker - lightweight message broker for MQTT

## Installation Templates

The following templates are executed in order during installation:

| Template | Description | Status |
|----------|-------------|--------|
| [set-parameters.json](templates/set-parameters.md) | Set application-specific parameters for Mosquitto | ✓ Executed |
| [010-get-latest-os-template.json](../../shared/templates/010-get-latest-os-template.md) | Download latest operating system template for Proxmox | ✓ Executed |
| [100-create-configure-lxc.json](../../shared/templates/100-create-configure-lxc.md) | Creates LXC container and applies optional configurations (templates 101-199) | ✓ Executed |
| └─ [104-lxc-static-ip-prefix.json](../../shared/templates/104-lxc-static-ip-prefix.md) | Optional step: Derive static IPv4/IPv6 from prefixes and VMID, emit... | <span style="color: #ffa500; font-weight: bold;">⚙️ Conditional (requires parameters)</span> |
| └─ [105-set-static-ip-for-lxc.json](../../shared/templates/105-set-static-ip-for-lxc.md) | Edit LXC network settings for a container with static IPs | <span style="color: #ff6b6b; font-weight: bold;">⏭️ All Commands Skipped</span> |
| └─ [106-update-etc-hosts-on-ve.json](../../shared/templates/106-update-etc-hosts-on-ve.md) | Optional template to update /etc/hosts with hostname and static IP ... | <span style="color: #ff6b6b; font-weight: bold;">⏭️ All Commands Skipped</span> |
| └─ [110-map-serial.json](../../shared/templates/110-map-serial.md) | Map serial device to VM | <span style="color: #ff6b6b; font-weight: bold;">⏭️ All Commands Skipped</span> |
| └─ [120-mount-disk-on-host.json](../../shared/templates/120-mount-disk-on-host.md) | Mounts a block device (by UUID) on the Proxmox host | ✓ Executed |
| └─ [121-mount-zfs-pool-on-host.json](../../shared/templates/121-mount-zfs-pool-on-host.md) | Creates a subdirectory under a ZFS pool mountpoint on the Proxmox host | <span style="color: #ffa500; font-weight: bold;">⚙️ Conditional (requires parameters)</span> |
| └─ [160-bind-multiple-volumes-to-lxc.json](../../shared/templates/160-bind-multiple-volumes-to-lxc.md) | Binds multiple host directories to an LXC container | <span style="color: #ffa500; font-weight: bold;">⚙️ Conditional (requires parameters)</span> |
| └─ [170-set-environment-variables-in-lxc.json](../../shared/templates/170-set-environment-variables-in-lxc.md) | Sets environment variables in an LXC container configuration | <span style="color: #ffa500; font-weight: bold;">⚙️ Conditional (requires parameters)</span> |
| [200-start-lxc.json](../../shared/templates/200-start-lxc.md) | Start existing LXC container on Proxmox host | ✓ Executed |
| [210-wait-for-container-ready.json](../../shared/templates/210-wait-for-container-ready.md) | Wait until LXC container is ready (network + apk available) | ✓ Executed |
| [305-set-pkg-mirror.json](../../shared/templates/305-set-pkg-mirror.md) | Configure package manager mirrors for Alpine Linux (apk) or Debian/Ubuntu (apt) | ✓ Executed |
| [330-install-packages.json](../../shared/templates/330-install-packages.md) | Install packages inside the LXC container | ✓ Executed |
| [configure-start-mosquitto.json](templates/configure-start-mosquitto.md) | Configure Mosquitto MQTT broker with authentication settings | ✓ Executed |

<!-- GENERATED_START:PARAMETERS -->
## Parameters

The following parameters can be configured for this application:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `hostname` | string | Yes | mosquitto | Hostname for the Mosquitto container |
| `auth_mode` | enum | Yes | password | Authentication mode: none (no authentication), password (username/password), certificate (client certificate authentication) |
| `mqtt_port` | string | No | 1883 | Port number for MQTT (default: 1883) ⚙️ Advanced |
| `mqtts_port` | string | No | 8883 | Port number for MQTT over TLS (default: 8883). Only used with certificate authentication. ⚙️ Advanced |
| `mqtt_username` | string | No | - | Username for MQTT broker login (required for password authentication mode) |
| `mqtt_password` | string | No | - | Password for MQTT broker login (required for password authentication mode) 🔒 Secure |
| `bind_address` | string | No | 0.0.0.0 | IP address to bind to. Use 0.0.0.0 to accept connections from all interfaces ⚙️ Advanced |
| `server_cert` | string | No | - | Server certificate file for TLS. If not provided, a server certificate will be generated. ⚙️ Advanced 📤 Upload |
| `server_key` | string | No | - | Server private key file for TLS. Required if server certificate is provided. ⚙️ Advanced 📤 Upload |
| `ca_cert` | string | No | - | CA certificate file for client certificate authentication (optional). If provided, client certificates will be required. ⚙️ Advanced 📤 Upload |
| `ca_key` | string | No | - | CA private key file (optional). Required if CA certificate is provided. ⚙️ Advanced 📤 Upload |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:COMMANDS -->
## Installation Commands

The following commands are executed during installation (in order):

| # | Command | Description | Status |
|---|---------|-------------|--------|
| 1 | `Mosquitto Parameters` | - | ✓ Executed |
| 2 | `Latest OS Template` | - | ✓ Executed |
| 3 | `Configure subuid/subgid` | - | ✓ Executed |
| 4 | `Create LXC container` | - | ✓ Executed |
| 5 | `Compute Static IPs (skipped)` | Skipped: all required parameters missing | ⏭️ Skipped |
| 6 | `lxc-static-ip (skipped)` | Skipped: all required parameters missing | ⏭️ Skipped |
| 7 | `lxc-update-etc-hosts (skipped)` | Skipped: all required parameters missing | ⏭️ Skipped |
| 8 | `Map Serial Device (skipped)` | Skipped: all required parameters missing | ⏭️ Skipped |
| 9 | `Mount Disk on Host` | Executes the script to mount the disk by UUID on the host. | ✓ Executed |
| 10 | `Mount ZFS Pool on Host` | Executes the script to create a subdirectory under the ZFS pool mountpoint on the host. | ✓ Executed |
| 11 | `Bind Multiple Volumes to LXC` | Executes the script to bind multiple volumes in the container. | ✓ Executed |
| 12 | `Env Variables in LXC (skipped)` | Skipped: all required parameters missing | ⏭️ Skipped |
| 13 | `Start LXC Container` | - | ✓ Executed |
| 14 | `Wait for Container` | Poll host until the LXC container reports readiness (network up, apk reachable) | ✓ Executed |
| 15 | `Set Package Mirror` | Configure package manager mirrors based on OS type | ✓ Executed |
| 16 | `Install Packages` | Install packages using the appropriate package manager (apk for Alpine, apt for Debian/Ubuntu) | ✓ Executed |
| 17 | `Configure Mosquitto` | Configure Mosquitto with authentication settings | ✓ Executed |

<!-- GENERATED_END:COMMANDS -->

## Features

This application provides the following features (documented in individual template files):

- See [set-parameters.json](templates/set-parameters.json.md) for details
- See [010-get-latest-os-template.json](../../shared/templates/010-get-latest-os-template.json.md) for details
- See [100-create-configure-lxc.json](../../shared/templates/100-create-configure-lxc.json.md) for details
- See [200-start-lxc.json](../../shared/templates/200-start-lxc.json.md) for details
- See [210-wait-for-container-ready.json](../../shared/templates/210-wait-for-container-ready.json.md) for details
- See [305-set-pkg-mirror.json](../../shared/templates/305-set-pkg-mirror.json.md) for details
- See [330-install-packages.json](../../shared/templates/330-install-packages.json.md) for details
- See [configure-start-mosquitto.json](templates/configure-start-mosquitto.json.md) for details
