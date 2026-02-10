#!/bin/sh
# List all LXC container IDs in the Proxmox cluster
#
# This script lists all LXC containers by:
# 1. Using pvesh to query Proxmox cluster
# 2. Building a JSON array of container objects
# 3. Outputting in Outputs schema format
#
# Output format: JSON array of objects with hostname, pve, and vm_id fields
# Example: [{"hostname":"ct1","pve":"pve1","vm_id":101}, ...]
#
# Requires:
#   - pvesh: Proxmox cluster tools (must be installed)
#
# Output: JSON to stdout (errors to stderr)

set -eu

if ! command -v pvesh >/dev/null 2>&1; then
  echo "pvesh not found; this script requires Proxmox cluster tools" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found; please install python3 on the Proxmox host" >&2
  exit 1
fi

python3 - <<'PY'
import json, subprocess, sys

def run_pvesh(args):
    try:
        res = subprocess.run(["pvesh"] + args, capture_output=True, text=True, check=True)
        return res.stdout
    except subprocess.CalledProcessError as e:
        sys.stderr.write(f"pvesh {' '.join(args)} failed: {e.stderr}\n")
        sys.exit(1)

# Get cluster resources and filter LXC
raw = run_pvesh(["get", "/cluster/resources", "--type", "vm", "--output-format", "json"])
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    # pvesh may output non-JSON (e.g. error); surface raw for debugging
    sys.stderr.write("Failed to parse pvesh cluster resources JSON\n")
    sys.exit(1)

lxc = [x for x in data if isinstance(x, dict) and x.get("type") == "lxc"]
result = []
for item in lxc:
    node = item.get("node")
    vmid = item.get("vmid")
    hostname = None
    if node is not None and vmid is not None:
        # Fetch container config to read hostname (may be empty)
        cfg_raw = run_pvesh(["get", f"/nodes/{node}/lxc/{vmid}/config", "--output-format", "json"])
        try:
            cfg = json.loads(cfg_raw)
            hostname = cfg.get("hostname")
        except json.JSONDecodeError:
            hostname = None
    if not hostname:
        hostname = str(vmid) if vmid is not None else ""
    result.append({
        "hostname": hostname,
        "pve": str(node) if node is not None else "",
        "vm_id": int(vmid) if isinstance(vmid, (int, float, str)) and str(vmid).isdigit() else vmid,
    })

# Build Outputs object with stringified array value
value_str = json.dumps(result, separators=(",", ":"))
outputs = {"id": "vm_ids", "value": value_str}
print(json.dumps(outputs))
PY
