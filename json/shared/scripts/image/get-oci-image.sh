#!/bin/sh

# OCI image reference (e.g., docker://alpine:latest, oci://ghcr.io/owner/repo:latest, oci://registry.example.com/image:tag)
# Since pveam download doesn't support OCI images yet, the image must be downloaded manually via Web UI
# This script searches for the image in the storage
OCI_IMAGE="{{ oci_image }}"
STORAGE="{{ storage }}"

if [ -z "$OCI_IMAGE" ]; then
  echo "Error: oci_image parameter is required!" >&2
  exit 1
fi

# Extract image name without protocol for searching
# Remove protocol prefix (docker://, oci://) to get the image reference
IMAGE_REF=$(echo "$OCI_IMAGE" | sed 's|^[^:]*://||')
# Extract base image name (without tag) for searching
# Handle cases like "willtho/samba-timemachine" or "timjdfletcher/samba-timemachine"
BASE_IMAGE=$(echo "$IMAGE_REF" | cut -d: -f1)
# Extract the last component (image name) for searching
# e.g., "willtho/samba-timemachine" -> "samba-timemachine"
IMAGE_NAME=$(echo "$BASE_IMAGE" | awk -F'/' '{print $NF}')
# Extract tag if present
IMAGE_TAG=$(echo "$IMAGE_REF" | cut -d: -f2)

echo "Searching for OCI image matching '$IMAGE_NAME'" >&2
if [ -n "$IMAGE_TAG" ]; then
  echo "  with tag '$IMAGE_TAG'" >&2
  # Proxmox stores OCI images as: <image-name>_<tag>.tar
  # e.g., "samba-timemachine_timemachine-v3.6.1.tar"
  SEARCH_PATTERN="${IMAGE_NAME}_${IMAGE_TAG}"
else
  echo "  (no tag specified)" >&2
  SEARCH_PATTERN="$IMAGE_NAME"
fi
echo "  in storage '$STORAGE'..." >&2

# Search for the image in storage
# pveam list shows images in format: <storage>:<path>
# e.g., "local:vztmpl/samba-timemachine_timemachine-v3.6.1.tar"
# Note: pveam list <storage> without --content option lists all content types
# First try exact match with tag
TEMPLATE_PATH=""
if [ -n "$IMAGE_TAG" ]; then
  TEMPLATE_PATH=$(pveam list "$STORAGE" 2>/dev/null | grep -i "$SEARCH_PATTERN" | head -n1 | awk '{print $1}')
fi

# If not found with tag, try just image name
if [ -z "$TEMPLATE_PATH" ]; then
  TEMPLATE_PATH=$(pveam list "$STORAGE" 2>/dev/null | grep -i "$IMAGE_NAME" | head -n1 | awk '{print $1}')
fi

if [ -z "$TEMPLATE_PATH" ]; then
  echo "Error: OCI image matching '$IMAGE_NAME' not found in storage '$STORAGE'" >&2
  echo "Available images:" >&2
  pveam list "$STORAGE" >&2
  echo "" >&2
  echo "Please download the OCI image manually via Proxmox Web UI:" >&2
  echo "  Datacenter -> Storage -> <storage> -> Content -> Upload -> Select OCI image" >&2
  exit 1
fi

echo "Found OCI image: $TEMPLATE_PATH" >&2

# Try to detect ostype from image name (fallback to alpine if not detectable)
OSTYPE="alpine"
if echo "$OCI_IMAGE" | grep -qi "debian"; then
  OSTYPE="debian"
elif echo "$OCI_IMAGE" | grep -qi "ubuntu"; then
  OSTYPE="ubuntu"
elif echo "$OCI_IMAGE" | grep -qi "alpine"; then
  OSTYPE="alpine"
elif echo "$OCI_IMAGE" | grep -qi "fedora"; then
  OSTYPE="fedora"
elif echo "$OCI_IMAGE" | grep -qi "centos"; then
  OSTYPE="centos"
fi

# Output the template path and ostype in JSON format
echo "Using OCI image: $TEMPLATE_PATH" >&2
echo "Detected ostype: $OSTYPE" >&2
echo '[{ "id": "template_path", "value": "'$TEMPLATE_PATH'"}, {"id": "ostype", "value": "'$OSTYPE'"}]'
exit 0
