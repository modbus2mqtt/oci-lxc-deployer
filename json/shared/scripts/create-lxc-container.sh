#!/bin/sh
# Create LXC container on Proxmox host
#
# This script creates an LXC container by:
# 1. Auto-selecting the best storage (prefers local-zfs, otherwise storage with most free space)
# 2. Creating the LXC container with specified parameters
# 3. Configuring container settings (hostname, ostype, etc.)
#
# Requires:
#   - vm_id: LXC container ID (from context)
#   - hostname: Container hostname (from context)
#   - ostype: Operating system type (from context)
#   - storage: Storage name (optional, auto-selected if not provided)
#
# Output: JSON to stdout (errors to stderr)
# Note: Do NOT use exec >&2 here, as it redirects ALL stdout to stderr, including JSON output

# Auto-select the best storage for LXC rootfs
# Prefer local-zfs if available, otherwise use storage with most free space (supports rootdir)

# First, check if local-zfs exists and supports rootdir
PREFERRED_STORAGE=""
if pvesm list "local-zfs" --content rootdir 2>/dev/null | grep -q .; then
  PREFERRED_STORAGE="local-zfs"
  echo "Using preferred storage: local-zfs" >&2
fi

# If local-zfs is not available, find storage with most free space
if [ -z "$PREFERRED_STORAGE" ]; then
  ROOTFS_RESULT=$(pvesm status | awk 'NR>1 {print $1, $6}' | while read stor free; do
    if pvesm list "$stor" --content rootdir 2>/dev/null | grep -q .; then
      if pvesm status --storage "$stor" | grep -q zfs; then
        echo "$free $stor size"
      else
        echo "$free $stor normal"
      fi
    fi
  done | sort -nr | head -n1)

  set -- $ROOTFS_RESULT
  PREFERRED_STORAGE=$2
fi

if [ -z "$PREFERRED_STORAGE" ]; then
  echo "No suitable storage found for LXC rootfs!" >&2
  exit 1
fi

stor="$PREFERRED_STORAGE"

ROOTFS="$stor:$(({{ disk_size }} * 1024))"
echo "Rootfs: $ROOTFS" >&2

# Auto-select VMID if not set
if [ -z "{{ vm_id }}" ]; then
  # Find the next free VMID (highest existing + 1)
  VMID=$(pvesh get /cluster/nextid)
else
  VMID="{{ vm_id }}"
fi

# Check that template_path is set
# Note: template_path should be set by 010-get-latest-os-template.json
TEMPLATE_PATH="{{ template_path }}"
if [ -z "$TEMPLATE_PATH" ] || [ "$TEMPLATE_PATH" = "" ] || [ "$TEMPLATE_PATH" = "NOT_DEFINED" ]; then
  echo "Error: template_path parameter is empty, not set, or resolved to NOT_DEFINED!" >&2
  echo "Current value: '$TEMPLATE_PATH'" >&2
  echo "Please ensure that 010-get-latest-os-template.json template is executed before 100-create-configure-lxc.json" >&2
  echo "The template should output: [{ \"id\": \"template_path\", \"value\": \"...\" }]" >&2
  exit 1
fi

# Create the container
# Note: uid and gid parameters are used for volume permissions, not for idmap
# Proxmox may try to automatically create idmap entries during container creation
# The error occurs during template extraction, so we cannot prevent it by editing config afterwards
# Instead, we need to ensure the container is created without triggering automatic idmap
# We'll create the container and then remove any idmap entries that were created
CONFIG_FILE="/etc/pve/lxc/${VMID}.conf"

# Create the container
# Note: The error "newuidmap: uid range [0-65536) -> [100000-165536) not allowed" 
# occurs because Proxmox tries to use idmap during template extraction.
# This happens even though we don't want idmap - uid/gid are only for volume permissions.
pct create "$VMID" "$TEMPLATE_PATH" \
  --rootfs "$ROOTFS" \
  --hostname "{{ hostname }}" \
  --memory "{{ memory }}" \
  --net0 name=eth0,bridge="{{ bridge }}",ip=dhcp \
  --ostype "{{ ostype }}" \
  --unprivileged 1 >&2
RC=$? 
if [ $RC -ne 0 ]; then
  echo "Failed to create LXC container!" >&2
  echo "Note: If you see 'newuidmap' errors, this may be due to automatic UID/GID mapping." >&2
  echo "The uid and gid parameters are used for volume permissions only, not for container idmap." >&2
  exit $RC
fi

# Remove any automatically created idmap entries from the container config
# uid and gid parameters are used for volume permissions, not for idmap configuration
if [ -f "$CONFIG_FILE" ]; then
  # Remove all lxc.idmap lines that Proxmox may have automatically added
  sed -i '/^lxc\.idmap/d' "$CONFIG_FILE" 2>/dev/null || true
fi

echo "LXC container $VMID ({{ hostname }}) created." >&2

# Write notes/description so we can later detect lxc-manager managed containers.
# Store the OCI image in a visible, identifiable line.
OCI_IMAGE_RAW="{{ oci_image }}"
OCI_IMAGE_VISIBLE=$(printf "%s" "$OCI_IMAGE_RAW" | sed -E 's#^(docker|oci)://##')
TEMPLATE_PATH_FOR_NOTES="$TEMPLATE_PATH"

APP_ID_RAW="{{ application_id }}"
APP_NAME_RAW="{{ application_name }}"
APP_ID=""
APP_NAME=""
if [ "$APP_ID_RAW" != "NOT_DEFINED" ]; then APP_ID="$APP_ID_RAW"; fi
if [ "$APP_NAME_RAW" != "NOT_DEFINED" ]; then APP_NAME="$APP_NAME_RAW"; fi

NOTES_TMP=$(mktemp)
{
  echo "<!-- lxc-manager:managed -->"
  if [ -n "$OCI_IMAGE_VISIBLE" ]; then
    echo "<!-- lxc-manager:oci-image $OCI_IMAGE_VISIBLE -->"
  fi
  if [ -n "$APP_ID" ]; then
    echo "<!-- lxc-manager:application-id $APP_ID -->"
  fi
  if [ -n "$APP_NAME" ]; then
    echo "<!-- lxc-manager:application-name $APP_NAME -->"
  fi
  echo "# LXC Manager"
  echo
  echo "Managed by **lxc-manager**."
  if [ -n "$APP_ID" ] || [ -n "$APP_NAME" ]; then
    echo
    if [ -n "$APP_ID" ] && [ -n "$APP_NAME" ]; then
      echo "Application: $APP_NAME ($APP_ID)"
    elif [ -n "$APP_NAME" ]; then
      echo "Application: $APP_NAME"
    else
      echo "Application ID: $APP_ID"
    fi
  fi
  if [ -n "$OCI_IMAGE_VISIBLE" ]; then
    echo
    echo "OCI image: $OCI_IMAGE_VISIBLE"
  else
    echo
    echo "LXC template: $TEMPLATE_PATH_FOR_NOTES"
  fi
} > "$NOTES_TMP"

# pct set --description supports multi-line text.
pct set "$VMID" --description "$(cat "$NOTES_TMP")" >&2 || true
rm -f "$NOTES_TMP"

echo '{ "id": "vm_id", "value": "'$VMID'" }'
