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

## Command Line Usage

LXC Manager can be used via command line to execute tasks for applications.

### Start Web Application

Start the web application server (default behavior when no command is specified):

```sh
lxc-manager [options]
```

**Options:**
- `--local <path>`: Path to the local data directory (default: `examples` in current working directory)
- `--secretsFilePath <path>`: Path to the secrets file for encryption/decryption

**Examples:**
```sh
lxc-manager
lxc-manager --local ./my-local
lxc-manager --local ./my-local --secretsFilePath ./secrets.txt
```

### Execute Tasks

Execute a task for a specific application:

```sh
lxc-manager exec <application> <task> <parameters file> [options]
```

**Arguments:**
- `<application>`: Name of the application to execute the task for
- `<task>`: Task type to execute. Valid values:
  - `installation`: Install the application
  - `backup`: Backup the application
  - `restore`: Restore the application
  - `uninstall`: Uninstall the application
  - `update`: Update the application
  - `upgrade`: Upgrade the application
  - `webui`: Open web UI for the application
- `<parameters file>`: Path to the JSON file containing task parameters (see [Parameters File Format](#parameters-file-format) below)

**Options:**
- `--local <path>`: Path to the local data directory (default: `local` in current working directory). If `--local` is specified without a value, uses `local`
- `--secretsFilePath <path>`: Path to the secrets file for encryption/decryption
- `--restartInfoFile <path>`: Path to the restart info JSON file (used for resuming interrupted tasks)

**Examples:**
```sh
# Install Node-RED
lxc-manager exec node-red installation ./params.json

# Install with custom local directory
lxc-manager exec node-red installation ./params.json --local ./my-local

# Backup with secrets file
lxc-manager exec node-red backup ./backup-params.json --secretsFilePath ./secrets.txt

# Resume interrupted task
lxc-manager exec node-red installation ./params.json --restartInfoFile ./restart-info.json
```

### Help

Display help information:

```sh
lxc-manager --help
# or
lxc-manager -h
```

## Parameters File Format

The parameters file is a JSON file that contains the input values required for executing a task. It must be a JSON array where each element is an object with `name` and `value` properties.

### Format

```json
[
  {
    "name": "parameter_name",
    "value": "parameter_value"
  },
  {
    "name": "another_parameter",
    "value": 123
  },
  {
    "name": "boolean_parameter",
    "value": true
  }
]
```

### Properties

- **`name`** (string, required): The name/ID of the parameter as defined in the application templates
- **`value`** (string | number | boolean, required): The value for the parameter. Can be:
  - A string (e.g., `"node-red"`, `"192.168.1.100"`)
  - A number (e.g., `123`, `3000`)
  - A boolean (e.g., `true`, `false`)

### Finding Required Parameters

To find out which parameters are required for a specific application and task, you can:

1. **Use the Web UI**: The web interface will show you all required and optional parameters with their descriptions
2. **Check application templates**: Look in `json/applications/<application-name>/` for template definitions
3. **Run without parameters file**: If you run the exec command without a parameters file, LXC Manager will output a template with all required parameter names (you'll need to fill in the values)

### Example Parameters File

Example for installing Node-RED:

```json
[
  {
    "name": "hostname",
    "value": "node-red"
  },
  {
    "name": "vm_id",
    "value": 100
  },
  {
    "name": "static_ip",
    "value": "192.168.1.100/24"
  },
  {
    "name": "gateway",
    "value": "192.168.1.1"
  }
]
```

### Notes

- Parameters with default values defined in templates are optional and don't need to be included in the parameters file
- Parameter names are case-sensitive and must match exactly as defined in the application templates
- The order of parameters in the array doesn't matter
- You can omit parameters that have default values defined in the templates

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

