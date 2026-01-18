#!/bin/sh
# Create and attach Proxmox storage volumes (mpX) to an LXC container
#
# Requires:
#   - vm_id: LXC container ID
#   - hostname: Container hostname
#   - volumes: key=container_path (one per line)
#   - volume_storage: Proxmox storage ID for volumes
#   - volume_size: default size for new volumes (e.g., 4G)
#   - volume_backup: include in backups (true/false)
#   - volume_shared: allow shared mount (true/false)
#   - uid/gid/mapped_uid/mapped_gid: ownership mapping

set -eu

VMID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
VOLUMES="{{ volumes }}"
VOLUME_STORAGE="{{ volume_storage }}"
VOLUME_SIZE="{{ volume_size }}"
VOLUME_BACKUP="{{ volume_backup }}"
VOLUME_SHARED="{{ volume_shared }}"
UID_VALUE="{{ uid }}"
GID_VALUE="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi
if [ -z "$HOSTNAME" ] || [ "$HOSTNAME" = "NOT_DEFINED" ]; then
  fail "hostname is required"
fi
if [ -z "$VOLUMES" ] || [ "$VOLUMES" = "NOT_DEFINED" ]; then
  fail "volumes is required"
fi
if [ -z "$VOLUME_STORAGE" ] || [ "$VOLUME_STORAGE" = "NOT_DEFINED" ]; then
  fail "volume_storage is required"
fi

if [ -z "$VOLUME_SIZE" ] || [ "$VOLUME_SIZE" = "NOT_DEFINED" ]; then
  VOLUME_SIZE="4G"
fi

PCT_CONFIG=$(pct config "$VMID" 2>/dev/null || true)

is_number() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

map_id_via_idmap() {
  _kind="$1" # u or g
  _cid="$2"
  echo "$PCT_CONFIG" | awk -v kind="$_kind" -v cid="$_cid" '
    $1 ~ /^lxc\.idmap[:=]$/ {
      k=$2; c=$3+0; h=$4+0; l=$5+0;
      if (k==kind && cid>=c && cid < (c+l)) {
        print h + (cid - c);
        exit 0;
      }
    }
    END { }
  '
}

IS_UNPRIV=0
if echo "$PCT_CONFIG" | grep -aqE '^unprivileged:\s*1\s*$'; then
  IS_UNPRIV=1
fi

EFFECTIVE_UID="$UID_VALUE"
EFFECTIVE_GID="$GID_VALUE"

if [ -n "$MAPPED_UID" ] && [ "$MAPPED_UID" != "" ]; then
  EFFECTIVE_UID="$MAPPED_UID"
elif is_number "$UID_VALUE"; then
  MID=$(map_id_via_idmap u "$UID_VALUE")
  if [ -n "$MID" ]; then
    EFFECTIVE_UID="$MID"
  elif [ "$IS_UNPRIV" -eq 1 ]; then
    EFFECTIVE_UID=$((100000 + UID_VALUE))
  fi
fi

if [ -n "$MAPPED_GID" ] && [ "$MAPPED_GID" != "" ]; then
  EFFECTIVE_GID="$MAPPED_GID"
elif is_number "$GID_VALUE"; then
  MID=$(map_id_via_idmap g "$GID_VALUE")
  if [ -n "$MID" ]; then
    EFFECTIVE_GID="$MID"
  elif [ "$IS_UNPRIV" -eq 1 ]; then
    EFFECTIVE_GID=$((100000 + GID_VALUE))
  fi
fi

log "storage-volumes: vm_id=$VMID host=$HOSTNAME storage=$VOLUME_STORAGE uid=$UID_VALUE gid=$GID_VALUE host_uid=$EFFECTIVE_UID host_gid=$EFFECTIVE_GID"

# Track used mp indices
USED_MPS=$(pct config "$VMID" | awk -F: '/^mp[0-9]+:/ { sub(/^mp/,"",$1); print $1 }' | tr '\n' ' ')
ASSIGNED_MPS=""

find_next_mp() {
  for i in $(seq 0 31); do
    case " $USED_MPS $ASSIGNED_MPS " in
      *" $i "*) ;;
      *) echo "mp$i"; return 0 ;;
    esac
  done
  echo ""
}

# Stop container if running (mp changes require stop)
WAS_RUNNING=0
if pct status "$VMID" 2>/dev/null | grep -aq 'status: running'; then
  WAS_RUNNING=1
fi

NEEDS_STOP=0

# Pre-clean: remove mp entries for target paths to re-apply options
TMPFILE=$(mktemp)
printf "%s\n" "$VOLUMES" > "$TMPFILE"
TARGETS=""
while IFS= read -r tline; do
  [ -z "$tline" ] && continue
  tval=$(echo "$tline" | cut -d'=' -f2- | cut -d',' -f1)
  [ -z "$tval" ] && continue
  tval=$(printf '%s' "$tval" | sed -E 's#^/*#/#')
  TARGETS="$TARGETS $tval"
done < "$TMPFILE"

for TARGET in $TARGETS; do
  MAP_LINES=$(pct config "$VMID" | grep -aE "^mp[0-9]+: .*mp=$TARGET" || true)
  if [ -n "$MAP_LINES" ]; then
    if [ "$NEEDS_STOP" -eq 0 ] && [ "$WAS_RUNNING" -eq 1 ]; then
      pct stop "$VMID" >&2 || true
      NEEDS_STOP=1
    fi
    printf '%s\n' "$MAP_LINES" | while IFS= read -r mline; do
      mpkey=$(echo "$mline" | cut -d: -f1)
      pct set "$VMID" -delete "$mpkey" >&2 || true
    done
  fi
  done

# Refresh used mp list
USED_MPS=$(pct config "$VMID" | awk -F: '/^mp[0-9]+:/ { sub(/^mp/,"",$1); print $1 }' | tr '\n' ' ')

sanitize_name() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

get_existing_volid() {
  name="$1"
  pvesm list "$VOLUME_STORAGE" --content rootdir 2>/dev/null | awk '{print $1}' | grep -i "${name}" | head -n1 || true
}

while IFS= read -r line <&3; do
  [ -z "$line" ] && continue
  VOLUME_KEY=$(echo "$line" | cut -d'=' -f1)
  VOLUME_REST=$(echo "$line" | cut -d'=' -f2-)
  VOLUME_PATH=$(echo "$VOLUME_REST" | cut -d',' -f1)
  [ -z "$VOLUME_KEY" ] && continue
  [ -z "$VOLUME_PATH" ] && continue
  VOLUME_PATH=$(printf '%s' "$VOLUME_PATH" | sed -E 's#^/*#/#')

  SAFE_HOST=$(sanitize_name "$HOSTNAME")
  SAFE_KEY=$(sanitize_name "$VOLUME_KEY")
  VOLNAME="vol-${SAFE_HOST}-${SAFE_KEY}"

  VOLID=$(get_existing_volid "$VOLNAME")
  if [ -z "$VOLID" ]; then
    log "Creating volume $VOLNAME in storage $VOLUME_STORAGE (size $VOLUME_SIZE)"
    VOLID=$(pvesm alloc "$VOLUME_STORAGE" "$VMID" "$VOLNAME" "$VOLUME_SIZE" 2>/dev/null || true)
  else
    log "Reusing existing volume $VOLID for $VOLNAME"
  fi

  if [ -z "$VOLID" ]; then
    fail "Failed to allocate or find volume for $VOLNAME"
  fi

  MP=$(find_next_mp)
  if [ -z "$MP" ]; then
    fail "No free mp slots available"
  fi
  ASSIGNED_MPS="$ASSIGNED_MPS ${MP#mp}"

  OPTS="mp=$VOLUME_PATH"
  if [ "$VOLUME_BACKUP" = "true" ] || [ "$VOLUME_BACKUP" = "1" ]; then
    OPTS="$OPTS,backup=1"
  fi
  if [ "$VOLUME_SHARED" = "true" ] || [ "$VOLUME_SHARED" = "1" ]; then
    OPTS="$OPTS,shared=1"
  fi

  if [ "$NEEDS_STOP" -eq 0 ] && [ "$WAS_RUNNING" -eq 1 ]; then
    pct stop "$VMID" >&2 || true
    NEEDS_STOP=1
  fi

  pct set "$VMID" -${MP} "${VOLID},${OPTS}" >&2

  VOLPATH=$(pvesm path "$VOLID" 2>/dev/null || true)
  if [ -n "$VOLPATH" ] && [ -n "$EFFECTIVE_UID" ] && [ -n "$EFFECTIVE_GID" ]; then
    chown "$EFFECTIVE_UID:$EFFECTIVE_GID" "$VOLPATH" 2>/dev/null || true
  fi

  log "Attached ${VOLID} to ${VOLUME_PATH} via ${MP}"

done 3< "$TMPFILE"

rm -f "$TMPFILE"

if [ "$WAS_RUNNING" -eq 1 ]; then
  pct start "$VMID" >/dev/null 2>&1 || true
fi

echo '[{"id":"volumes_attached","value":"true"}]'
