#!/bin/sh
# List Proxmox storage IDs that support LXC rootdir (storage volumes)
# Output format: JSON array of objects with name and value fields
# Example: [{"name":"local-zfs (zfs, 120G free)","value":"local-zfs"}, ...]

set -eu

now_sec() {
  date +%s
}

log_timing() {
  echo "[rootdir-storage] $*" >&2
}

START_TS=$(now_sec)

TIMEOUT_CMD="timeout"
if ! command -v timeout >/dev/null 2>&1; then
  if command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_CMD="gtimeout"
  else
    TIMEOUT_CMD=""
  fi
fi
if [ -z "$TIMEOUT_CMD" ]; then
  log_timing "timeout missing; commands may run without a time limit"
fi

run_with_timeout() {
  local timeout_sec="${1:-2}"
  shift
  if [ -n "$TIMEOUT_CMD" ]; then
    $TIMEOUT_CMD "$timeout_sec" "$@" 2>/dev/null || return 1
  else
    if ! command -v "$1" >/dev/null 2>&1; then
      return 1
    fi
    "$@" 2>/dev/null || return 1
  fi
}

FIRST=true
COUNT=0
printf '['

add_item() {
  _name="$1"
  _value="$2"
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    printf ','
  fi
  printf '{"name":"%s","value":"%s"}' "$_name" "$_value"
  COUNT=$((COUNT + 1))
}

# Prefer pvesm status --content rootdir if available
STATUS_START=$(now_sec)
if run_with_timeout 2 pvesm status --content rootdir >/tmp/pvesm_rootdir.$$ 2>/dev/null; then
  STATUS_END=$(now_sec)
  log_timing "pvesm status --content rootdir ${STATUS_END}s (start=${STATUS_START}s, elapsed=$((STATUS_END-STATUS_START))s)"
  line_no=0
  while IFS= read -r line; do
    line_no=$((line_no + 1))
    if [ "$line_no" -eq 1 ]; then
      continue
    fi
    name=$(echo "$line" | awk '{print $1}')
    type=$(echo "$line" | awk '{print $2}')
    avail=$(echo "$line" | awk '{print $6}')
    [ -z "$name" ] && continue
    label="$name"
    if [ -n "$type" ] || [ -n "$avail" ]; then
      label="$name"
      if [ -n "$type" ] && [ -n "$avail" ]; then
        label="$name ($type, ${avail} free)"
      elif [ -n "$type" ]; then
        label="$name ($type)"
      elif [ -n "$avail" ]; then
        label="$name (${avail} free)"
      fi
    fi
    add_item "$label" "$name"
  done < /tmp/pvesm_rootdir.$$
  rm -f /tmp/pvesm_rootdir.$$ 2>/dev/null || true
else
  STATUS_END=$(now_sec)
  log_timing "pvesm status --content rootdir failed ${STATUS_END}s (start=${STATUS_START}s, elapsed=$((STATUS_END-STATUS_START))s)"
fi

if [ "$COUNT" -eq 0 ]; then
  # Fallback: list all storages and filter by rootdir content
  log_timing "fallback: scanning storages"
  STORAGES=$(run_with_timeout 2 pvesm status | awk 'NR>1 {print $1}' || echo "")
  for stor in $STORAGES; do
    ITEM_START=$(now_sec)
    if run_with_timeout 1 pvesm list "$stor" --content rootdir >/dev/null 2>&1; then
      ITEM_END=$(now_sec)
      log_timing "pvesm list $stor --content rootdir ok (elapsed=$((ITEM_END-ITEM_START))s)"
      add_item "$stor" "$stor"
    else
      ITEM_END=$(now_sec)
      log_timing "pvesm list $stor --content rootdir failed (elapsed=$((ITEM_END-ITEM_START))s)"
    fi
  done
fi

END_TS=$(now_sec)
log_timing "total elapsed=$((END_TS-START_TS))s, count=$COUNT"

printf ']\n'
exit 0
