#!/bin/sh
# Create Proxmox storage volumes and optionally attach them (mpX) to an LXC container
#
# Requires:
#   - vm_id: LXC container ID (optional; if omitted, no attach happens)
#   - hostname: Container hostname (required when volumes are provided)
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

ATTACH_TO_CT=0
if [ -n "$VMID" ] && [ "$VMID" != "NOT_DEFINED" ]; then
  ATTACH_TO_CT=1
fi

if [ -z "$VOLUMES" ] || [ "$VOLUMES" = "NOT_DEFINED" ]; then
  VOLUMES=""
fi

if [ -n "$VOLUMES" ]; then
  if [ -z "$HOSTNAME" ] || [ "$HOSTNAME" = "NOT_DEFINED" ]; then
    fail "hostname is required when volumes are provided"
  fi
fi
if [ -z "$VOLUME_STORAGE" ] || [ "$VOLUME_STORAGE" = "NOT_DEFINED" ]; then
  fail "volume_storage is required"
fi

if [ -z "$VOLUME_SIZE" ] || [ "$VOLUME_SIZE" = "NOT_DEFINED" ]; then
  VOLUME_SIZE="4G"
fi

PCT_CONFIG=""
if [ "$ATTACH_TO_CT" -eq 1 ]; then
  PCT_CONFIG=$(pct config "$VMID" 2>/dev/null || true)
fi

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
if [ "$ATTACH_TO_CT" -eq 1 ]; then
  if echo "$PCT_CONFIG" | grep -aqE '^unprivileged:\s*1\s*$'; then
    IS_UNPRIV=1
  fi
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

log "storage-volumes: vm_id=$VMID host=$HOSTNAME storage=$VOLUME_STORAGE uid=$UID_VALUE gid=$GID_VALUE host_uid=$EFFECTIVE_UID host_gid=$EFFECTIVE_GID attach=$ATTACH_TO_CT"

# Track used mp indices
USED_MPS=""
ASSIGNED_MPS=""
if [ "$ATTACH_TO_CT" -eq 1 ]; then
  USED_MPS=$(pct config "$VMID" | awk -F: '/^mp[0-9]+:/ { sub(/^mp/,"",$1); print $1 }' | tr '\n' ' ')
fi

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
if [ "$ATTACH_TO_CT" -eq 1 ]; then
  if pct status "$VMID" 2>/dev/null | grep -aq 'status: running'; then
    WAS_RUNNING=1
  fi
fi

NEEDS_STOP=0

# Pre-clean: remove mp entries for target paths to re-apply options
TMPFILE=$(mktemp)
printf "%s\n" "$VOLUMES" > "$TMPFILE"
if [ "$ATTACH_TO_CT" -eq 1 ] && [ -n "$VOLUMES" ]; then
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
fi

# Refresh used mp list
if [ "$ATTACH_TO_CT" -eq 1 ]; then
  USED_MPS=$(pct config "$VMID" | awk -F: '/^mp[0-9]+:/ { sub(/^mp/,"",$1); print $1 }' | tr '\n' ' ')
fi

sanitize_name() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

get_existing_volid() {
  name="$1"
  storage_type="$2"
  if [ "$storage_type" = "zfspool" ]; then
    _volid=$(pvesm list "$VOLUME_STORAGE" --content rootdir 2>/dev/null \
      | awk '{print $1}' \
      | grep -Ei -- "subvol-[0-9]+-${name}$" \
      | head -n1 || true)
    if [ -n "$_volid" ]; then
      echo "$_volid"
      return 0
    fi
    _pool=$(get_zfs_pool)
    if [ -n "$_pool" ] && zfs list -H -o name "${_pool}/${name}" >/dev/null 2>&1; then
      echo "${VOLUME_STORAGE}:${name}"
      return 0
    fi
  else
    pvesm list "$VOLUME_STORAGE" --content rootdir 2>/dev/null \
      | awk '{print $1}' \
      | grep -i -- "${name}" \
      | head -n1 || true
  fi
}

get_storage_type() {
  pvesm status -storage "$VOLUME_STORAGE" 2>/dev/null | awk 'NR==2 {print $2}' || true
}

alloc_volume() {
  _volname="$1"
  _size="$2"
  _owner_vmid="$3"
  if [ -z "$_owner_vmid" ]; then
    _owner_vmid="$VMID"
  fi
  _type=$(get_storage_type)
  _errfile=$(mktemp)
  _volid=""

  _volid=$(pvesm alloc "$VOLUME_STORAGE" "$_owner_vmid" "$_volname" "$_size" 2>"$_errfile" || true)
  _rc=$?
  if [ "$_rc" -eq 0 ] && [ -n "$_volid" ]; then
    rm -f "$_errfile"
    echo "$_volid"
    return 0
  fi

  if [ "$_type" = "zfspool" ]; then
    _volid=$(pvesm alloc "$VOLUME_STORAGE" "$_owner_vmid" "$_volname" "$_size" --format subvol 2>"$_errfile" || true)
    _rc=$?
    if [ "$_rc" -eq 0 ] && [ -n "$_volid" ]; then
      rm -f "$_errfile"
      echo "$_volid"
      return 0
    fi
  fi

  _err=$(cat "$_errfile" 2>/dev/null || true)
  rm -f "$_errfile"
  log "pvesm alloc failed (type=$_type): ${_err}"
  return 1
}

get_zfs_pool() {
  if [ -r /etc/pve/storage.cfg ]; then
    awk -v storage="$VOLUME_STORAGE" '
      $1 ~ /^zfspool:/ { inblock=0 }
      $1 == "zfspool:" && $2 == storage { inblock=1 }
      inblock && $1 == "pool" { print $2; exit }
    ' /etc/pve/storage.cfg 2>/dev/null || true
  fi
}

resolve_volume_path() {
  _volid="$1"
  _volname="$2"
  _type="$3"

  _path=""
  _i=0
  while [ "$_i" -lt 10 ]; do
    _path="$(pvesm path "$_volid" 2>/dev/null || true)"
    if [ -n "$_path" ]; then
      echo "$_path"
      return 0
    fi
    sleep 1
    _i=$(( _i + 1 ))
  done

  if [ "$_type" = "zfspool" ]; then
    _pool=$(get_zfs_pool)
    if [ -n "$_pool" ]; then
      _mp=$(zfs get -H -o value mountpoint "${_pool}/${_volname}" 2>/dev/null || true)
      if [ -z "$_mp" ] || [ "$_mp" = "-" ] || [ "$_mp" = "none" ]; then
        _mp=$(zfs list -H -o mountpoint "${_pool}/${_volname}" 2>/dev/null || true)
      fi
      if [ -n "$_mp" ] && [ "$_mp" != "-" ] && [ "$_mp" != "none" ]; then
        echo "$_mp"
        return 0
      fi
    fi
  fi
  return 1
}

STORAGE_TYPE=$(get_storage_type)
SAFE_HOST=$(sanitize_name "$HOSTNAME")
SHARED_OWNER_VMID="${SHARED_OWNER_VMID:-999999}"
SHARED_NAME_KEY="oci-lxc-deployer-volumes"
if [ "$STORAGE_TYPE" = "zfspool" ]; then
  SHARED_VOLNAME="subvol-${SHARED_OWNER_VMID}-${SHARED_NAME_KEY}"
else
  SHARED_VOLNAME="vol-${SHARED_NAME_KEY}"
fi

SHARED_VOLID=$(get_existing_volid "$SHARED_NAME_KEY" "$STORAGE_TYPE")
if [ -z "$SHARED_VOLID" ]; then
  log "Creating shared volume $SHARED_VOLNAME in storage $VOLUME_STORAGE (size $VOLUME_SIZE)"
  SHARED_VOLID=$(alloc_volume "$SHARED_VOLNAME" "$VOLUME_SIZE" "$SHARED_OWNER_VMID" || true)
  if [ -z "$SHARED_VOLID" ] && [ "$STORAGE_TYPE" = "zfspool" ]; then
    _pool=$(get_zfs_pool)
    if [ -n "$_pool" ] && zfs list -H -o name "${_pool}/${SHARED_VOLNAME}" >/dev/null 2>&1; then
      SHARED_VOLID="${VOLUME_STORAGE}:${SHARED_VOLNAME}"
    fi
  fi
fi

if [ -z "$SHARED_VOLID" ]; then
  fail "Failed to allocate or find shared volume for ${SHARED_VOLNAME}"
fi

SHARED_VOLNAME_REAL="${SHARED_VOLID#*:}"
SHARED_VOLPATH=$(resolve_volume_path "$SHARED_VOLID" "$SHARED_VOLNAME_REAL" "$STORAGE_TYPE" || true)
if [ -z "$SHARED_VOLPATH" ]; then
  fail "Failed to resolve path for shared volume ${SHARED_VOLID}"
fi

while IFS= read -r line <&3; do
  [ -z "$line" ] && continue
  VOLUME_KEY=$(echo "$line" | cut -d'=' -f1)
  VOLUME_REST=$(echo "$line" | cut -d'=' -f2-)
  VOLUME_PATH=$(echo "$VOLUME_REST" | cut -d',' -f1)
  VOLUME_OPTS=$(echo "$VOLUME_REST" | cut -d',' -f2-)
  [ -z "$VOLUME_KEY" ] && continue
  [ -z "$VOLUME_PATH" ] && continue
  VOLUME_PATH=$(printf '%s' "$VOLUME_PATH" | sed -E 's#^/*#/#')

  SAFE_KEY=$(sanitize_name "$VOLUME_KEY")
  SUBDIR="${SHARED_VOLPATH}/volumes/${SAFE_HOST}/${SAFE_KEY}"
  mkdir -p "$SUBDIR"

  PERM=$(printf '%s' "$VOLUME_OPTS" | tr ',' '\n' | awk '/^[0-9]{3,4}$/ {print $1; exit}')
  if [ -n "$PERM" ]; then
    chmod "$PERM" "$SUBDIR" 2>/dev/null || true
  fi
  if [ -n "$EFFECTIVE_UID" ] && [ -n "$EFFECTIVE_GID" ]; then
    chown "$EFFECTIVE_UID:$EFFECTIVE_GID" "$SUBDIR" 2>/dev/null || true
  fi

  if [ "$ATTACH_TO_CT" -eq 1 ]; then
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

    pct set "$VMID" -${MP} "${SUBDIR},${OPTS}" >&2

    log "Attached ${SUBDIR} to ${VOLUME_PATH} via ${MP}"
  else
    log "Prepared ${SUBDIR} (no CT attach)"
  fi

done 3< "$TMPFILE"

rm -f "$TMPFILE"

if [ "$ATTACH_TO_CT" -eq 1 ]; then
  if [ "$WAS_RUNNING" -eq 1 ]; then
    pct start "$VMID" >/dev/null 2>&1 || true
  fi
  echo '[{"id":"volumes_attached","value":"true"}]'
else
  echo '[{"id":"volumes_attached","value":"false"}]'
fi
