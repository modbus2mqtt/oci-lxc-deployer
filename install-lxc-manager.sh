#!/bin/sh
set -eu
# Static GitHub source configuration
OWNER="volkmarnissen"
REPO="lxc-manager"
BRANCH="main"

# install-lxc-manager.sh
# Runs on a Proxmox host, downloads and executes scripts from GitHub
# with placeholder substitutions, extracts a requested output parameter
# from the JSON output and prints it to stdout.
#
# Requirements: curl, sed, sh, awk/grep
# No dependency on jq.

# execute_script_from_github <path> <output_id> [key=value ...]
# - path: file path within the static GitHub source (raw content)
# - output_id: the JSON output parameter (e.g. template_path) to extract
# - key=value: arbitrary placeholders to replace in the template
#   Replacement pattern: {{ key }} → value
execute_script_from_github() {
  if [ "$#" -lt 2 ]; then
    echo "Usage: execute_script_from_github <path> <output_id|-> [key=value ...]" >&2
    echo "Hint: use '-' as <output_id> to bypass JSON extraction and print raw output." >&2
    return 2
  fi
  path="$1"; output_id="$2"; shift 2

  raw_url="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${path}"

  # Fetch script and build sed replacements for all provided key=value pairs
  # Replaces {{ key }} with value (whitespace tolerant)
  sed_args=""
  for kv in "$@"; do
    key="${kv%%=*}"
    val="${kv#*=}"
    # Escape sed special characters in value
    esc_val=$(printf '%s' "$val" | sed 's/[\\&/]/\\&/g')
    # Replace {{ key }} with val (with arbitrary spaces around key)
    sed_args="$sed_args -e s/{{[[:space:]]*$key[[:space:]]*}}/$esc_val/g"
  done

  # Execute the fetched script with substitutions and capture output
  # shellcheck disable=SC2086
  script_output=$(curl -fsSL "$raw_url" | sed $sed_args | sh)

  # If output_id is '-', print raw output and return
  if [ "$output_id" = "-" ]; then
    printf '%s\n' "$script_output"
    return 0
  fi

  # Extract desired output from JSON lines: { "id": "<output_id>", "value": "..." }
  # Robust without jq: find line with matching id and get its value
  output_value=$(printf '%s\n' "$script_output" \
    | awk -v ID="$output_id" '
      BEGIN { FS="\"" }
      /"id"[[:space:]]*:[[:space:]]*"/ {
        # Suche Paare id/value in der Zeile
        for (i=1; i<=NF; i++) {
          if ($i=="id" && $(i+2)==ID) {
            # value steht in späterem Segment; finde das nächste Auftreten von "value" und nimm dessen Wert
            for (j=i; j<=NF; j++) {
              if ($j=="value") { print $(j+2); exit }
            }
          }
        }
      }')

  if [ -n "$output_value" ]; then
    printf '%s\n' "$output_value"
    return 0
  else
    echo "ERROR: Output id '$output_id' not found" >&2
    printf '%s\n' "$script_output" >&2
    return 3
  fi
}

# Example: determine the latest Alpine template path
# Call: replaces {{ ostype }} with "alpine" and extracts 'template_path'
# Note: adjust repo/owner/branch if needed
if [ "${1:-}" = "--example" ]; then
  execute_script_from_github \
    "backend/json/shared/scripts/get-latest-os-template.sh" \
    "template_path" \
    "ostype=alpine"
fi

# CLI with optional parameters and defaults
# Optional parameters with defaults:
# - vm_id (default "")
# - disk_size (default 1)
# - memory (default 256)
# - bridge (default vmbr0)
# - hostname (default lxc-manager)
# - static_ip (default "")
# - static_gw (default "")
# - static_ip6 (default "")
# - static_gw6 (default "")

# Defaults
vm_id=""
disk_size="1"
memory="256"
bridge="vmbr0"
hostname="lxc-manager"
static_ip=""
static_gw=""
static_ip6=""
static_gw6=""
use_static_ip="false"
nameserver4=""
nameserver6=""

# Parse optional CLI flags
while [ "$#" -gt 0 ]; do
  case "$1" in
    --vm-id) vm_id="$2"; shift 2 ;;
    --disk-size) disk_size="$2"; shift 2 ;;
    --memory) memory="$2"; shift 2 ;;
    --bridge) bridge="$2"; shift 2 ;;
    --hostname) hostname="$2"; shift 2 ;;
    --static-ip) static_ip="$2"; shift 2 ;;
    --static-gw) static_gw="$2"; shift 2 ;;
    --static-ip6) static_ip6="$2"; shift 2 ;;
    --static-gw6) static_gw6="$2"; shift 2 ;;
    --nameserver4) nameserver4="$2"; shift 2 ;;
    --nameserver6) nameserver6="$2"; shift 2 ;;
    --help|-h)
      cat >&2 <<USAGE
Usage: $0 [options]

Installs the lxc-manager as an LXC container on a Proxmox host.
Typical IPv4 example:
  $0 --static-ip 192.168.4.100/24 --static-gw 192.168.1.1

Options:
  --vm-id <id>          Optional VMID. If empty, the next free VMID is chosen.
  --disk-size <GB>      LXC rootfs size in GB. Default: 1
  --memory <MB>         Container memory in MB. Default: 256
  --bridge <name>       Network bridge (e.g. vmbr0). Default: vmbr0
  --hostname <name>     Container hostname. Default: lxc-manager
  --static-ip <CIDR>    IPv4 address in CIDR notation, e.g. 192.168.4.100/24
                        When set, you may also provide --static-gw.
  --static-gw <IP>      IPv4 gateway, e.g. 192.168.4.1. Requires --static-ip.
  --static-ip6 <CIDR>   IPv6 address in CIDR notation, e.g. fd00::50/64
                        When set, you may also provide --static-gw6.
  --static-gw6 <IP>     IPv6 gateway, e.g. fd00::1. Requires --static-ip6.
  --nameserver4 <IP>    IPv4 DNS nameserver, e.g. 192.168.1.1 (optional).
  --nameserver6 <IP>    IPv6 DNS nameserver, e.g. fd00:...::1 or 2001:...::1 (optional).

Notes:
  - Template is auto-selected for ostype=alpine.
  - IP/gateway validation ensures proper CIDR formats and presence dependencies.
USAGE
      exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# 1) Get latest OS template path (ostype=alpine)
template_path=$(execute_script_from_github \
  "backend/json/shared/scripts/get-latest-os-template.sh" \
  "template_path" \
  "ostype=alpine")

# decide static ip usage
:

# 2) Create LXC container with collected parameters
vm_id=$(execute_script_from_github \
  "backend/json/shared/scripts/create-lxc-container.sh" \
  "vm_id" \
  "template_path=$template_path" \
  "vm_id=$vm_id" \
  "disk_size=$disk_size" \
  "memory=$memory" \
  "bridge=$bridge" \
  "hostname=$hostname" \
  "ostype=alpine")

execute_script_from_github \
  "backend/json/shared/scripts/lxc-static-ip.sh" \
  "-" \
  "vm_id=$vm_id" \
  "bridge=$bridge" \
  "hostname=$hostname" \
  "static_ip=$static_ip" \
  "static_gw=$static_gw" \
  "static_ip6=$static_ip6" \
  "static_gw6=$static_gw6" \
  "nameserver4=$nameserver4" \
  "nameserver6=$nameserver6"
exit 0
