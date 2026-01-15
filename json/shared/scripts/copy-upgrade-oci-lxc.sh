#!/bin/sh
# Copy-upgrade an LXC container using a new OCI image.
#
# Steps:
# 1) Verify source container exists and was created by lxc-manager (marker in description/notes).
# 2) Create a new container from the downloaded OCI template (template_path) to generate a fresh rootfs.
# 3) Merge configuration: keep new rootfs + new ostype, copy remaining config from source.
# 4) Update notes/description to include an identifiable OCI image line.
#
# Inputs (templated):
#   - source_vm_id (required)
#   - vm_id (optional target id)
#   - template_path (required; from 011-get-oci-image.json)
#   - ostype (optional; from 011-get-oci-image.json)
#   - oci_image (required; from 011-get-oci-image.json)
#   - disk_size, bridge, memory (optional)
#
# Output:
#   - JSON to stdout: {"id":"vm_id","value":"<target>"}

set -eu

SOURCE_VMID="{{ source_vm_id }}"
TARGET_VMID_INPUT="{{ vm_id }}"
TEMPLATE_PATH="{{ template_path }}"
NEW_OSTYPE="{{ ostype }}"
OCI_IMAGE_RAW="{{ oci_image }}"
DISK_SIZE_GB="{{ disk_size }}"
BRIDGE="{{ bridge }}"
MEMORY="{{ memory }}"

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

# Normalize OCI image for notes (strip scheme if present)
OCI_IMAGE_VISIBLE=$(printf "%s" "$OCI_IMAGE_RAW" | sed -E 's#^(docker|oci)://##')

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

# Detect lxc-manager marker in notes/description
# We accept either an HTML comment marker or a visible header.
if ! printf "%s\n" "$SOURCE_DESC" | grep -qiE 'lxc-manager:managed|^# LXC Manager|Managed by .*lxc-manager'; then
  fail "Source container does not look like it was created by lxc-manager (missing notes marker)."
fi

# Determine target VMID
if [ -z "$TARGET_VMID_INPUT" ] || [ "$TARGET_VMID_INPUT" = "" ]; then
  TARGET_VMID=$(pvesh get /cluster/nextid)
else
  TARGET_VMID="$TARGET_VMID_INPUT"
fi

TARGET_CONF="${CONFIG_DIR}/${TARGET_VMID}.conf"
if [ -f "$TARGET_CONF" ]; then
  fail "Target container config already exists: $TARGET_CONF"
fi

# Auto-select storage for rootfs (same idea as create-lxc-container.sh)
PREFERRED_STORAGE=""
if pvesm list "local-zfs" --content rootdir 2>/dev/null | grep -q .; then
  PREFERRED_STORAGE="local-zfs"
  log "Using preferred storage: local-zfs"
fi

if [ -z "$PREFERRED_STORAGE" ]; then
  ROOTFS_RESULT=$(pvesm status | awk 'NR>1 {print $1, $6}' | while read stor free; do
    if pvesm list "$stor" --content rootdir 2>/dev/null | grep -q .; then
      echo "$free $stor"
    fi
  done | sort -nr | head -n1)

  set -- $ROOTFS_RESULT
  PREFERRED_STORAGE=${2:-""}
fi

if [ -z "$PREFERRED_STORAGE" ]; then
  fail "No suitable storage found for LXC rootfs"
fi

stor="$PREFERRED_STORAGE"
if [ -z "$DISK_SIZE_GB" ]; then
  DISK_SIZE_GB="4"
fi
ROOTFS="${stor}:$((DISK_SIZE_GB * 1024))"

log "Creating target container $TARGET_VMID from template '$TEMPLATE_PATH'"

# Create a minimal container to get a fresh rootfs reference
# (we will replace most of the config afterwards)
pct create "$TARGET_VMID" "$TEMPLATE_PATH" \
  --rootfs "$ROOTFS" \
  --hostname "upgrade-${TARGET_VMID}" \
  --memory "$MEMORY" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  ${NEW_OSTYPE:+--ostype "$NEW_OSTYPE"} \
  --unprivileged 1 >&2

if [ ! -f "$TARGET_CONF" ]; then
  fail "Target container config was not created: $TARGET_CONF"
fi

# Capture new rootfs and ostype from the newly created config
NEW_ROOTFS_LINE=$(grep -E '^rootfs:' "$TARGET_CONF" | head -n1 || true)
if [ -z "$NEW_ROOTFS_LINE" ]; then
  fail "Could not find rootfs line in target config"
fi

NEW_OSTYPE_LINE=$(grep -E '^ostype:' "$TARGET_CONF" | head -n1 || true)

# Build new description block (keep source notes, but update/add OCI image line)
# Strategy:
# - Keep all source description lines except old OCI image markers.
# - Ensure lxc-manager markers are present.
# - Add a visible line: "OCI image: <image>".
TMP_DESC=$(mktemp)
{
  printf "<!-- lxc-manager:managed -->\n"
  if [ -n "$OCI_IMAGE_VISIBLE" ]; then
    printf "<!-- lxc-manager:oci-image %s -->\n" "$OCI_IMAGE_VISIBLE"
  fi
  if [ -n "$APP_ID" ]; then
    printf "<!-- lxc-manager:application-id %s -->\n" "$APP_ID"
  fi
  if [ -n "$APP_NAME" ]; then
    printf "<!-- lxc-manager:application-name %s -->\n" "$APP_NAME"
  fi
  printf "# LXC Manager\n\n"
  printf "Managed by **lxc-manager**.\n\n"
  if [ -n "$APP_ID" ] || [ -n "$APP_NAME" ]; then
    if [ -n "$APP_ID" ] && [ -n "$APP_NAME" ]; then
      printf "Application: %s (%s)\n\n" "$APP_NAME" "$APP_ID"
    elif [ -n "$APP_NAME" ]; then
      printf "Application: %s\n\n" "$APP_NAME"
    else
      printf "Application ID: %s\n\n" "$APP_ID"
    fi
  fi
  if [ -n "$OCI_IMAGE_VISIBLE" ]; then
    printf "OCI image: %s\n\n" "$OCI_IMAGE_VISIBLE"
  fi
  # Append remaining source description, stripped of previous OCI-image markers to avoid duplicates
  if [ -n "$SOURCE_DESC" ]; then
    printf "%s\n" "$SOURCE_DESC" \
      | grep -vE 'lxc-manager:oci-image|^OCI image:' \
      | sed '/^$/N;/^\n$/D'
  fi
} > "$TMP_DESC"

# Assemble merged config
# Base: source config
# Replace: rootfs + ostype
# Replace: description block
MERGED_CONF=$(mktemp)

# Write everything except existing description and rootfs/ostype
awk '
  BEGIN { in_desc=0 }
  /^description:/ { in_desc=1; next }
  in_desc==1 {
    if ($0 ~ /^[[:space:]]+/) next;
    in_desc=0;
  }
  /^rootfs:/ { next }
  /^ostype:/ { next }
  { print }
' "$SOURCE_CONF" > "$MERGED_CONF"

# Append new rootfs/ostype and new description
{
  echo "$NEW_ROOTFS_LINE"
  if [ -n "$NEW_OSTYPE_LINE" ]; then
    echo "$NEW_OSTYPE_LINE"
  elif [ -n "$NEW_OSTYPE" ]; then
    echo "ostype: $NEW_OSTYPE"
  fi

  # Proxmox multiline description: first line 'description: ...', continuation lines indented.
  FIRST_LINE=$(head -n1 "$TMP_DESC" | sed 's/\r$//')
  echo "description: $FIRST_LINE"
  tail -n +2 "$TMP_DESC" | sed 's/\r$//' | sed 's/^/ /'
} >> "$MERGED_CONF"

rm -f "$TMP_DESC"

# Replace target config with merged config
cp "$MERGED_CONF" "$TARGET_CONF" >&2
rm -f "$MERGED_CONF"

# Remove any idmap lines that might have been added during pct create
sed -i '/^lxc\.idmap/d' "$TARGET_CONF" 2>/dev/null || true

# Warn if config still contains obvious references to source VMID in storage volumes
if grep -qE "subvol-${SOURCE_VMID}-disk-|vm-${SOURCE_VMID}-disk-" "$TARGET_CONF"; then
  log "Warning: merged config still references source VMID in storage volumes."
  log "         If you use Proxmox storage volumes (not bind mounts), you may need to adjust mp lines manually."
fi

log "Copy-upgrade prepared: source=$SOURCE_VMID target=$TARGET_VMID"

printf '{ "id": "vm_id", "value": "%s" }' "$TARGET_VMID"
