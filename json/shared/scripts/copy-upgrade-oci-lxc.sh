#!/bin/sh
# Copy-upgrade an LXC container using a new OCI image.
#
# Steps:
# 1) Verify source container exists and was created by oci-lxc-deployer (marker in description/notes).
# 2) Determine target VMID (existing or next free).
# 3) Output target VMID for subsequent steps.
#
# Inputs (templated):
#   - source_vm_id (required)
#   - vm_id (optional target id)
#   - template_path (required; from 011-get-oci-image.json)
#   - ostype (optional; from 011-get-oci-image.json)
#   - oci_image (required; from 011-get-oci-image.json)
#
# Output:
#   - JSON to stdout: {"id":"vm_id","value":"<target>"}

set -eu

SOURCE_VMID="{{ source_vm_id }}"
TARGET_VMID_INPUT="{{ vm_id }}"
TEMPLATE_PATH="{{ template_path }}"
NEW_OSTYPE="{{ ostype }}"
OCI_IMAGE_RAW="{{ oci_image }}"

APP_ID_RAW="{{ application_id }}"
APP_NAME_RAW="{{ application_name }}"
APP_ID=""
APP_NAME=""
if [ "$APP_ID_RAW" != "NOT_DEFINED" ]; then APP_ID="$APP_ID_RAW"; fi
if [ "$APP_NAME_RAW" != "NOT_DEFINED" ]; then APP_NAME="$APP_NAME_RAW"; fi

CONFIG_DIR="/etc/pve/lxc"
SOURCE_CONF="${CONFIG_DIR}/${SOURCE_VMID}.conf"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$SOURCE_VMID" ]; then
  fail "source_vm_id is required"
fi

if [ ! -f "$SOURCE_CONF" ]; then
  fail "Source container config not found: $SOURCE_CONF"
fi

if [ -z "$TEMPLATE_PATH" ] || [ "$TEMPLATE_PATH" = "NOT_DEFINED" ]; then
  fail "template_path is missing (expected from 011-get-oci-image.json)"
fi

# Extract description block from a Proxmox config (description: ... + indented continuation lines)
extract_description() {
  awk '
    BEGIN { in_desc=0; out="" }
    /^description:/ {
      in_desc=1;
      sub(/^description:[ ]?/, "", $0);
      print $0;
      next
    }
    in_desc==1 {
      if ($0 ~ /^[[:space:]]+/) {
        sub(/^[[:space:]]+/, "", $0);
        print $0;
        next
      }
      exit
    }
  ' "$1" || true
}

SOURCE_DESC=$(extract_description "$SOURCE_CONF")
SOURCE_CONF_TEXT=$(cat "$SOURCE_CONF" 2>/dev/null || echo "")
decode_url() {
  # Decode %XX sequences in Proxmox description lines (POSIX sh compatible)
  python3 - <<'PY' "$1"
import sys
from urllib.parse import unquote

print(unquote(sys.argv[1] if len(sys.argv) > 1 else ""))
PY
}
SOURCE_DESC_DECODED=$(decode_url "$SOURCE_DESC")
SOURCE_CONF_TEXT_DECODED=$(decode_url "$SOURCE_CONF_TEXT")

# Detect oci-lxc-deployer marker in notes/description
# We accept either an HTML comment marker, a visible header, or URL-encoded markers.
if ! printf "%s\n" "$SOURCE_DESC" | grep -qiE 'oci-lxc-deployer:managed|oci-lxc-deployer%3Amanaged|^# OCI LXC Deployer|Managed by .*oci-lxc-deployer' \
  && ! printf "%s\n" "$SOURCE_DESC_DECODED" | grep -qiE 'oci-lxc-deployer:managed|^# OCI LXC Deployer|Managed by .*oci-lxc-deployer' \
  && ! printf "%s\n" "$SOURCE_CONF_TEXT" | grep -qiE 'oci-lxc-deployer:managed|oci-lxc-deployer%3Amanaged' \
  && ! printf "%s\n" "$SOURCE_CONF_TEXT_DECODED" | grep -qiE 'oci-lxc-deployer:managed'; then
  fail "Source container does not look like it was created by oci-lxc-deployer (missing notes marker)."
fi

# Determine target VMID
if [ -z "$TARGET_VMID_INPUT" ] || [ "$TARGET_VMID_INPUT" = "" ]; then
  TARGET_VMID=$(pvesh get /cluster/nextid)
else
  TARGET_VMID="$TARGET_VMID_INPUT"
fi
log "Copy-upgrade prepared: source=$SOURCE_VMID target=$TARGET_VMID"

printf '{ "id": "vm_id", "value": "%s" }' "$TARGET_VMID"
