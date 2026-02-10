#!/bin/sh
# Stop source LXC and start target LXC. If start fails, try to restart source.
#
# Requires:
#   - source_vm_id: Source container ID (required)
#   - vm_id: Target container ID (required)
#   - template_path: OCI template path (required)
#   - ostype: Optional OS type for target container
#   - oci_image: OCI image reference (required)

set -eu

SOURCE_VMID="{{ source_vm_id }}"
TARGET_VMID="{{ vm_id }}"
TEMPLATE_PATH="{{ template_path }}"
NEW_OSTYPE="{{ ostype }}"
OCI_IMAGE_RAW="{{ oci_image }}"
APP_ID_RAW="{{ application_id }}"
APP_NAME_RAW="{{ application_name }}"
APP_ID=""
APP_NAME=""
if [ "$APP_ID_RAW" != "NOT_DEFINED" ]; then APP_ID="$APP_ID_RAW"; fi
if [ "$APP_NAME_RAW" != "NOT_DEFINED" ]; then APP_NAME="$APP_NAME_RAW"; fi

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "source_vm_id is required"
fi
if [ -z "$TARGET_VMID" ] || [ "$TARGET_VMID" = "NOT_DEFINED" ]; then
  fail "vm_id (target) is required"
fi
if [ -z "$TEMPLATE_PATH" ] || [ "$TEMPLATE_PATH" = "NOT_DEFINED" ]; then
  fail "template_path is required"
fi
if [ -z "$OCI_IMAGE_RAW" ] || [ "$OCI_IMAGE_RAW" = "NOT_DEFINED" ]; then
  fail "oci_image is required"
fi

CONFIG_DIR="/etc/pve/lxc"
SOURCE_CONF="${CONFIG_DIR}/${SOURCE_VMID}.conf"
TARGET_CONF="${CONFIG_DIR}/${TARGET_VMID}.conf"

if [ ! -f "$SOURCE_CONF" ]; then
  fail "Source container config not found: $SOURCE_CONF"
fi

get_conf_value() {
  key="$1"
  awk -v k="$key" -F':' 'BEGIN { found=0 }
    $1==k { sub(/^[^:]+:[ ]?/, "", $0); print $0; found=1; exit }
    END { if (!found) exit 1 }' "$SOURCE_CONF" 2>/dev/null
}

get_conf_line() {
  key="$1"
  awk -v k="$key" 'index($0, k":") == 1 { print $0; exit }' "$SOURCE_CONF" 2>/dev/null
}

normalize_size_to_gb() {
  val="$1"
  case "$val" in
    *[Tt])
      num=${val%[Tt]}
      echo $((num * 1024))
      ;;
    *[Gg])
      echo "${val%[Gg]}"
      ;;
    *[Mm])
      num=${val%[Mm]}
      awk -v m="$num" 'BEGIN { gb = int((m + 1023) / 1024); if (gb < 1) gb = 1; print gb }'
      ;;
    *[Kk])
      num=${val%[Kk]}
      awk -v k="$num" 'BEGIN { gb = int((k / 1024 / 1024) + 0.999); if (gb < 1) gb = 1; print gb }'
      ;;
    *)
      echo "$val"
      ;;
  esac
}

create_target_from_source() {
  if [ -f "$TARGET_CONF" ]; then
    log "Target config already exists: $TARGET_CONF (skipping create)"
    return 0
  fi

  SOURCE_ROOTFS_LINE=$(get_conf_line "rootfs" || true)
  SOURCE_ROOTFS_STORAGE=""
  SOURCE_ROOTFS_SIZE=""
  if [ -n "$SOURCE_ROOTFS_LINE" ]; then
    SOURCE_ROOTFS_STORAGE=$(printf "%s" "$SOURCE_ROOTFS_LINE" | sed -E 's/^rootfs:[ ]*([^:]+):.*/\1/;t;d')
    SOURCE_ROOTFS_SIZE=$(printf "%s" "$SOURCE_ROOTFS_LINE" | sed -E 's/.*size=([^, ]+).*/\1/;t;d')
  fi

  stor="$SOURCE_ROOTFS_STORAGE"
  if [ -z "$stor" ]; then
    stor="local-zfs"
  fi

  SIZE_INPUT="$SOURCE_ROOTFS_SIZE"
  if [ -z "$SIZE_INPUT" ]; then
    SIZE_INPUT="4G"
  fi

  if [ "$stor" = "local-zfs" ]; then
    SIZE_GB=$(normalize_size_to_gb "$SIZE_INPUT")
    ROOTFS="${stor}:${SIZE_GB}"
  else
    case "$SIZE_INPUT" in
      *[TtGgMmKk]) ROOTFS="${stor}:${SIZE_INPUT}" ;;
      *) ROOTFS="${stor}:${SIZE_INPUT}G" ;;
    esac
  fi

  HOSTNAME=$(get_conf_value "hostname" || true)
  MEMORY=$(get_conf_value "memory" || true)
  SWAP=$(get_conf_value "swap" || true)
  CORES=$(get_conf_value "cores" || true)
  NET0=$(get_conf_value "net0" || true)
  UNPRIVILEGED=$(get_conf_value "unprivileged" || true)
  ARCH=$(get_conf_value "arch" || true)
  OSTYPE_SRC=$(get_conf_value "ostype" || true)

  if [ -z "$HOSTNAME" ]; then HOSTNAME="upgrade-${TARGET_VMID}"; fi
  if [ -z "$MEMORY" ]; then MEMORY="512"; fi
  if [ -z "$SWAP" ]; then SWAP="512"; fi
  if [ -z "$CORES" ]; then CORES="1"; fi
  if [ -z "$NET0" ]; then NET0="name=eth0,bridge=vmbr0,ip=dhcp"; fi

  OSTYPE_ARG=""
  if [ -n "$NEW_OSTYPE" ] && [ "$NEW_OSTYPE" != "NOT_DEFINED" ]; then
    OSTYPE_ARG="$NEW_OSTYPE"
  elif [ -n "$OSTYPE_SRC" ]; then
    OSTYPE_ARG="$OSTYPE_SRC"
  fi

  log "Creating target container $TARGET_VMID from template '$TEMPLATE_PATH'"
  pct create "$TARGET_VMID" "$TEMPLATE_PATH" \
    --rootfs "$ROOTFS" \
    --hostname "$HOSTNAME" \
    --memory "$MEMORY" \
    --swap "$SWAP" \
    --cores "$CORES" \
    --net0 "$NET0" \
    ${OSTYPE_ARG:+--ostype "$OSTYPE_ARG"} \
    ${ARCH:+--arch "$ARCH"} \
    ${UNPRIVILEGED:+--unprivileged "$UNPRIVILEGED"} \
    >&2

  if [ ! -f "$TARGET_CONF" ]; then
    fail "Target container config was not created: $TARGET_CONF"
  fi
}

copy_mappings_only() {
  MAPPINGS=$(grep -E '^(mp[0-9]+:|lxc\.mount\.entry:|dev[0-9]+:|usb[0-9]+:|lxc\.cgroup2\.devices\.)' "$SOURCE_CONF" 2>/dev/null || true)

  TMP_CONF=$(mktemp)
  awk '
    /^mp[0-9]+:/ { next }
    /^lxc\.mount\.entry:/ { next }
    /^dev[0-9]+:/ { next }
    /^usb[0-9]+:/ { next }
    /^lxc\.cgroup2\.devices\./ { next }
    { print }
  ' "$TARGET_CONF" > "$TMP_CONF"

  if [ -n "$MAPPINGS" ]; then
    printf "%s\n" "$MAPPINGS" >> "$TMP_CONF"
  fi

  cp "$TMP_CONF" "$TARGET_CONF" >&2
  rm -f "$TMP_CONF"
}

write_notes_block() {
  OCI_IMAGE_VISIBLE=$(printf "%s" "$OCI_IMAGE_RAW" | sed -E 's#^(docker|oci)://##')

  TMP_DESC=$(mktemp)
  {
    printf "<!-- oci-lxc-deployer:managed -->\n"
    if [ -n "$OCI_IMAGE_VISIBLE" ]; then
      printf "<!-- oci-lxc-deployer:oci-image %s -->\n" "$OCI_IMAGE_VISIBLE"
    fi
    if [ -n "$APP_ID" ]; then
      printf "<!-- oci-lxc-deployer:application-id %s -->\n" "$APP_ID"
    fi
    if [ -n "$APP_NAME" ]; then
      printf "<!-- oci-lxc-deployer:application-name %s -->\n" "$APP_NAME"
    fi
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
  } > "$TMP_DESC"

  TMP_CONF=$(mktemp)
  awk '
    # Drop existing OCI LXC Deployer note/comment block (raw or URL-encoded)
    /^#.*oci-lxc-deployer/ { next }
    /^#.*OCI LXC Deployer/ { next }
    /^#.*Managed by .*oci-lxc-deployer/ { next }
    /^#.*Application:/ { next }
    /^#.*Application ID:/ { next }
    /^#.*OCI image:/ { next }
    { print }
  ' "$TARGET_CONF" > "$TMP_CONF"

  while IFS= read -r line; do
    printf '#%s\n' "$line"
  done < "$TMP_DESC" >> "$TMP_CONF"

  cp "$TMP_CONF" "$TARGET_CONF" >&2
  rm -f "$TMP_CONF" "$TMP_DESC"
}

create_target_from_source
copy_mappings_only
write_notes_block

source_status=$(pct status "$SOURCE_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
target_status=$(pct status "$TARGET_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")

log "Source $SOURCE_VMID status: $source_status"
log "Target $TARGET_VMID status: $target_status"

# Stop source if running
if [ "$source_status" = "running" ]; then
  log "Stopping source container $SOURCE_VMID..."
  if ! pct stop "$SOURCE_VMID" >/dev/null 2>&1; then
    fail "Failed to stop source container $SOURCE_VMID"
  fi
fi

# Start target if not running
if [ "$target_status" != "running" ]; then
  log "Starting target container $TARGET_VMID..."
  START_EXIT=0
  START_ERROR=""
  ATTEMPTS=3
  WAIT_SECONDS=40
  INTERVAL=2
  attempt=1
  while [ "$attempt" -le "$ATTEMPTS" ]; do
    START_ERROR=$(pct start "$TARGET_VMID" 2>&1) || START_EXIT=$?
    ELAPSED=0
    while [ "$ELAPSED" -lt "$WAIT_SECONDS" ]; do
      target_status=$(pct status "$TARGET_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
      if [ "$target_status" = "running" ]; then
        START_EXIT=0
        break
      fi
      sleep "$INTERVAL"
      ELAPSED=$((ELAPSED + INTERVAL))
    done
    if [ "$target_status" = "running" ]; then
      break
    fi
    attempt=$((attempt + 1))
  done
  if [ "$target_status" != "running" ]; then
    log "Failed to start target container $TARGET_VMID. Trying to restart source $SOURCE_VMID..."
    pct start "$SOURCE_VMID" >/dev/null 2>&1 || log "Warning: failed to restart source $SOURCE_VMID"
    log "=== Original error message ==="
    log "$START_ERROR"
    log "=== Diagnostic information ==="
    pct status "$TARGET_VMID" >&2 || true
    pct config "$TARGET_VMID" >&2 || true
    fail "Failed to start target container $TARGET_VMID"
  elif [ "$START_EXIT" -ne 0 ]; then
    log "Warning: start returned non-zero, but container is running. Output:"
    log "$START_ERROR"
  fi
fi

echo '[{"id":"started","value":"true"}]'