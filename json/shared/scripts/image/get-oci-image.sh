#!/bin/sh

# OCI image reference (e.g., docker://alpine:latest, oci://ghcr.io/owner/repo:latest, oci://registry.example.com/image:tag)
# Since pveam download doesn't support OCI images yet, the image must be downloaded manually via Web UI
# This script searches for the image in the storage
#
# When tag is "latest", skopeo is used to resolve the actual version:
#   1. Try org.opencontainers.image.version label
#   2. Fallback: digest-matching against version tags
# Requires: skopeo (available on PVE >= 9.1)
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

# --- Resolve "latest" tag to actual version ---
RESOLVED_VERSION=""
if [ "$IMAGE_TAG" = "latest" ] && command -v skopeo >/dev/null 2>&1; then
  echo "Resolving 'latest' tag for $BASE_IMAGE..." >&2

  INSPECT_JSON=$(skopeo inspect "docker://${BASE_IMAGE}:latest" 2>/dev/null)
  if [ -n "$INSPECT_JSON" ]; then
    # Step 1: Try org.opencontainers.image.version label
    RESOLVED_VERSION=$(echo "$INSPECT_JSON" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('Labels', {}).get('org.opencontainers.image.version', ''))
except: pass
" 2>/dev/null)

    if [ -n "$RESOLVED_VERSION" ]; then
      echo "Resolved 'latest' via label to version: $RESOLVED_VERSION" >&2
    else
      # Step 2: Digest matching against locally available images
      # Instead of querying all remote tags (slow), we only check versions
      # that are already present in storage (typically 1-2 API calls)
      echo "No version label found, trying digest matching against local images..." >&2
      LATEST_DIGEST=$(echo "$INSPECT_JSON" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('Digest', ''))
except: pass
" 2>/dev/null)

      if [ -n "$LATEST_DIGEST" ]; then
        # Extract version tags from local storage filenames
        # e.g., "local:vztmpl/postgres_17.5.tar" -> "17.5"
        LOCAL_TAGS=$(pveam list "$STORAGE" 2>/dev/null | grep -i "$IMAGE_NAME" | awk '{print $1}' | python3 -c "
import sys, re
for line in sys.stdin:
    line = line.strip()
    # Extract tag from filename: imagename_TAG.tar
    m = re.search(r'${IMAGE_NAME}_([^/]+?)\.tar', line, re.IGNORECASE)
    if m:
        tag = m.group(1)
        if tag != 'latest':
            print(tag)
" 2>/dev/null)

        if [ -n "$LOCAL_TAGS" ]; then
          echo "  Local versions found: $(echo $LOCAL_TAGS | tr '\n' ' ')" >&2
          for LTAG in $LOCAL_TAGS; do
            echo "  checking digest for tag '$LTAG'..." >&2
            LTAG_DIGEST=$(skopeo inspect "docker://${BASE_IMAGE}:${LTAG}" 2>/dev/null | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('Digest', ''))
except: pass
" 2>/dev/null)
            if [ "$LTAG_DIGEST" = "$LATEST_DIGEST" ]; then
              RESOLVED_VERSION="$LTAG"
              echo "Resolved 'latest' via digest matching to local: $RESOLVED_VERSION" >&2
              break
            fi
          done
        fi

        # Fallback: if no local match, try remote tags
        if [ -z "$RESOLVED_VERSION" ]; then
          echo "  No local digest match, checking remote tags..." >&2
          CANDIDATE_TAGS=$(skopeo list-tags "docker://${BASE_IMAGE}" 2>/dev/null | python3 -c "
import json, sys, re
try:
    d = json.load(sys.stdin)
    tags = [t for t in d.get('Tags', []) if re.match(r'^[0-9][0-9.]*$', t)]
    tags.sort(key=lambda t: [int(x) for x in t.split('.')], reverse=True)
    for t in tags[:5]:
        print(t)
except: pass
" 2>/dev/null)

          for CTAG in $CANDIDATE_TAGS; do
            CTAG_DIGEST=$(skopeo inspect "docker://${BASE_IMAGE}:${CTAG}" 2>/dev/null | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('Digest', ''))
except: pass
" 2>/dev/null)
            if [ "$CTAG_DIGEST" = "$LATEST_DIGEST" ]; then
              RESOLVED_VERSION="$CTAG"
              echo "Resolved 'latest' via remote digest matching to: $RESOLVED_VERSION" >&2
              break
            fi
          done
        fi

        if [ -z "$RESOLVED_VERSION" ]; then
          echo "Digest matching found no version tag for 'latest'" >&2
        fi
      fi
    fi
  else
    echo "skopeo inspect failed - continuing with 'latest' tag" >&2
  fi
elif [ "$IMAGE_TAG" = "latest" ]; then
  echo "Warning: skopeo not available - cannot resolve 'latest' to actual version" >&2
  echo "  Install skopeo for version resolution (available on PVE >= 9.1)" >&2
fi

# --- Search for image in storage ---
# pveam list shows images in format: <storage>:<path>
# e.g., "local:vztmpl/samba-timemachine_timemachine-v3.6.1.tar"
echo "Searching for OCI image matching '$IMAGE_NAME' in storage '$STORAGE'..." >&2

TEMPLATE_PATH=""

# 1. Try resolved version first (e.g., postgres_17.5)
if [ -n "$RESOLVED_VERSION" ]; then
  SEARCH="${IMAGE_NAME}_${RESOLVED_VERSION}"
  echo "  trying resolved version: $SEARCH" >&2
  TEMPLATE_PATH=$(pveam list "$STORAGE" 2>/dev/null | grep -i "$SEARCH" | head -n1 | awk '{print $1}')
fi

# 2. Try original tag (e.g., postgres_latest)
if [ -z "$TEMPLATE_PATH" ] && [ -n "$IMAGE_TAG" ]; then
  SEARCH="${IMAGE_NAME}_${IMAGE_TAG}"
  echo "  trying original tag: $SEARCH" >&2
  TEMPLATE_PATH=$(pveam list "$STORAGE" 2>/dev/null | grep -i "$SEARCH" | head -n1 | awk '{print $1}')
fi

# 3. Try just image name, pick latest version via sort -V
if [ -z "$TEMPLATE_PATH" ]; then
  echo "  trying any version of: $IMAGE_NAME" >&2
  TEMPLATE_PATH=$(pveam list "$STORAGE" 2>/dev/null | grep -i "$IMAGE_NAME" | sort -V | tail -n1 | awk '{print $1}')
fi

if [ -z "$TEMPLATE_PATH" ]; then
  echo "Error: OCI image matching '$IMAGE_NAME' not found in storage '$STORAGE'" >&2
  if [ -n "$RESOLVED_VERSION" ]; then
    echo "  'latest' resolves to version $RESOLVED_VERSION" >&2
    echo "  Please upload the image as: ${IMAGE_NAME}_${RESOLVED_VERSION}.tar" >&2
  fi
  echo "Available images:" >&2
  pveam list "$STORAGE" >&2
  echo "" >&2
  echo "Please download the OCI image manually via Proxmox Web UI:" >&2
  echo "  Datacenter -> Storage -> <storage> -> Content -> Upload -> Select OCI image" >&2
  exit 1
fi

echo "Found OCI image: $TEMPLATE_PATH" >&2

# --- Check if image is suitable for LXC (not distroless/minimal) ---
# LXC requires a full OS rootfs with /etc/passwd, init system, etc.
# Distroless/scratch-based images lack these and will fail at pct create.
if command -v skopeo >/dev/null 2>&1; then
  CHECK_JSON="$INSPECT_JSON"
  if [ -z "$CHECK_JSON" ]; then
    CHECK_JSON=$(skopeo inspect "docker://${BASE_IMAGE}:${IMAGE_TAG}" 2>/dev/null)
  fi
  if [ -n "$CHECK_JSON" ]; then
    IS_MINIMAL=$(echo "$CHECK_JSON" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    labels = d.get('Labels') or {}
    base = labels.get('org.opencontainers.image.base.name', '')
    layers = len(d.get('Layers', []))
    # Detect known distroless/scratch patterns
    if 'scratch' in base or 'distroless' in base or 'static' in base:
        print('distroless')
    elif layers < 3 and not any(os in base.lower() for os in ['alpine','debian','ubuntu','fedora','centos']):
        # Few layers and no known OS base -> likely minimal
        # Also check if any known OS appears in env
        env = d.get('Env', [])
        has_os_hint = any(k in str(env).lower() for k in ['alpine','debian','ubuntu','apt','apk'])
        if not has_os_hint:
            print('minimal')
        else:
            print('ok')
    else:
        print('ok')
except:
    print('unknown')
" 2>/dev/null)

    if [ "$IS_MINIMAL" = "distroless" ] || [ "$IS_MINIMAL" = "minimal" ]; then
      echo "" >&2
      echo "Error: OCI image '$BASE_IMAGE:$IMAGE_TAG' appears to be a $IS_MINIMAL image." >&2
      echo "  Minimal/distroless images cannot be used directly as LXC templates" >&2
      echo "  because they lack /etc/passwd, an init system, and a full OS filesystem." >&2
      echo "" >&2
      echo "  Use the 'docker-compose' framework instead:" >&2
      echo "  It creates a full Alpine/Debian LXC and runs the application via docker-compose." >&2
      exit 1
    fi
  fi
fi

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
