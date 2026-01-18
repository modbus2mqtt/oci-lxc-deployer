#!/bin/sh
# List Proxmox storage IDs that support LXC rootdir (storage volumes)
# Output format: JSON array of objects with name and value fields
# Example: [{"name":"local-zfs (zfs, 120G free)","value":"local-zfs"}, ...]

set -eu

TIMEOUT_CMD="timeout"
if ! command -v timeout >/dev/null 2>&1; then
  if command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_CMD="gtimeout"
  else
    TIMEOUT_CMD=""
  fi
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
}

# Prefer pvesm status --content rootdir if available
if run_with_timeout 2 pvesm status --content rootdir >/tmp/pvesm_rootdir.$$ 2>/dev/null; then
  while IFS= read -r line; do
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
  done < <(awk 'NR>1 {print}' /tmp/pvesm_rootdir.$$)
  rm -f /tmp/pvesm_rootdir.$$ 2>/dev/null || true
else
  # Fallback: list all storages and filter by rootdir content
  STORAGES=$(run_with_timeout 2 pvesm status | awk 'NR>1 {print $1}' || echo "")
  for stor in $STORAGES; do
    if run_with_timeout 1 pvesm list "$stor" --content rootdir >/dev/null 2>&1; then
      add_item "$stor" "$stor"
    fi
  done
fi

printf ']\n'
exit 0
