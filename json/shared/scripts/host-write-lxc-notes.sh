#!/bin/sh
# host-write-lxc-notes.sh
# Writes the LXC container notes/description.
# Called at the end of conf-* scripts, before container start.
# This allows all configuration scripts to contribute their information.

set -eu

VMID="{{ vm_id }}"
CONFIG_FILE="/etc/pve/lxc/${VMID}.conf"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Container config file not found: $CONFIG_FILE" >&2
  exit 1
fi

# Get template_path from config (for non-OCI installations)
TEMPLATE_PATH="{{ template_path }}"
if [ "$TEMPLATE_PATH" = "NOT_DEFINED" ]; then TEMPLATE_PATH=""; fi

# OCI image info
OCI_IMAGE_RAW="{{ oci_image }}"
if [ "$OCI_IMAGE_RAW" = "NOT_DEFINED" ]; then OCI_IMAGE_RAW=""; fi
OCI_IMAGE_VISIBLE=$(printf "%s" "$OCI_IMAGE_RAW" | sed -E 's#^(docker|oci)://##')

# Application info
APP_ID_RAW="{{ application_id }}"
APP_NAME_RAW="{{ application_name }}"
APP_ID=""
APP_NAME=""
if [ "$APP_ID_RAW" != "NOT_DEFINED" ]; then APP_ID="$APP_ID_RAW"; fi
if [ "$APP_NAME_RAW" != "NOT_DEFINED" ]; then APP_NAME="$APP_NAME_RAW"; fi

# Version info (from OCI image tag)
VERSION_RAW="{{ oci_image_tag }}"
VERSION=""
if [ "$VERSION_RAW" != "NOT_DEFINED" ]; then VERSION="$VERSION_RAW"; fi

# Log viewer URL parameters (auto-injected by backend)
DEPLOYER_URL_RAW="{{ deployer_base_url }}"
VE_CONTEXT_RAW="{{ ve_context_key }}"
if [ "$DEPLOYER_URL_RAW" = "NOT_DEFINED" ]; then DEPLOYER_URL_RAW=""; fi
if [ "$VE_CONTEXT_RAW" = "NOT_DEFINED" ]; then VE_CONTEXT_RAW=""; fi

# Hostname for log file path
HOSTNAME_RAW="{{ hostname }}"
if [ "$HOSTNAME_RAW" = "NOT_DEFINED" ]; then HOSTNAME_RAW=""; fi

# Log file path (matches conf-create-lxc-container.sh)
LOG_FILE="/var/log/lxc/${HOSTNAME_RAW}-${VMID}.log"

# Build notes content
NOTES_TMP=$(mktemp)
{
  # Hidden markers for machine parsing
  echo "<!-- oci-lxc-deployer:managed -->"
  if [ -n "$OCI_IMAGE_VISIBLE" ]; then
    echo "<!-- oci-lxc-deployer:oci-image $OCI_IMAGE_VISIBLE -->"
  fi
  if [ -n "$APP_ID" ]; then
    echo "<!-- oci-lxc-deployer:application-id $APP_ID -->"
  fi
  if [ -n "$APP_NAME" ]; then
    echo "<!-- oci-lxc-deployer:application-name $APP_NAME -->"
  fi
  if [ -n "$VERSION" ]; then
    echo "<!-- oci-lxc-deployer:version $VERSION -->"
  fi
  if [ -n "$DEPLOYER_URL_RAW" ] && [ -n "$VE_CONTEXT_RAW" ]; then
    echo "<!-- oci-lxc-deployer:log-url ${DEPLOYER_URL_RAW}/logs/${VMID}/${VE_CONTEXT_RAW} -->"
  fi
  if [ -n "$DEPLOYER_URL_RAW" ] && [ -n "$APP_ID" ]; then
    echo "<!-- oci-lxc-deployer:icon-url ${DEPLOYER_URL_RAW}/icons/${APP_ID}.png -->"
  fi

  # Visible content (Markdown)
  echo "# LXC Manager"
  echo

  # Show application icon if available
  if [ -n "$DEPLOYER_URL_RAW" ] && [ -n "$APP_ID" ]; then
    echo "![${APP_NAME:-$APP_ID}](${DEPLOYER_URL_RAW}/icons/${APP_ID}.png)"
    echo
  fi

  echo "Managed by **lxc-manager**."

  # Application info
  if [ -n "$APP_ID" ] || [ -n "$APP_NAME" ]; then
    echo
    if [ -n "$APP_ID" ] && [ -n "$APP_NAME" ]; then
      echo "## $APP_NAME"
      echo
      echo "Application ID: $APP_ID"
    elif [ -n "$APP_NAME" ]; then
      echo "## $APP_NAME"
    else
      echo "Application ID: $APP_ID"
    fi
  fi

  # Version
  if [ -n "$VERSION" ]; then
    echo
    echo "Version: $VERSION"
  fi

  # OCI image or LXC template
  if [ -n "$OCI_IMAGE_VISIBLE" ]; then
    echo
    echo "OCI image: $OCI_IMAGE_VISIBLE"
  elif [ -n "$TEMPLATE_PATH" ]; then
    echo
    echo "LXC template: $TEMPLATE_PATH"
  fi

  # Log file location
  if [ -n "$HOSTNAME_RAW" ]; then
    echo
    echo "Log file: $LOG_FILE"
  fi

  # Links section
  if [ -n "$DEPLOYER_URL_RAW" ] && [ -n "$VE_CONTEXT_RAW" ]; then
    echo
    echo "## Links"
    echo "- [Console Logs](${DEPLOYER_URL_RAW}/logs/${VMID}/${VE_CONTEXT_RAW})"
  fi
} > "$NOTES_TMP"

# pct set --description supports multi-line text
pct set "$VMID" --description "$(cat "$NOTES_TMP")" >&2 || true
rm -f "$NOTES_TMP"

echo "Notes written for container $VMID" >&2
echo '{ "id": "notes_written", "value": "true" }'
