#!/bin/sh
# Upload configuration files to volume directories BEFORE container start
#
# Paths use format: {volume_key}:{filename}
# Example: samba_config:smb.conf -> ${SHARED_VOLPATH}/volumes/${hostname}/samba-config/smb.conf
#
# Absolute paths (starting with /) are skipped - they should be handled post-start
#
# Requires:
#   - shared_volpath: Base path from template 150
#   - hostname: Container hostname
#   - addon_content/addon_path and app_contentN/app_pathN pairs
#   - uid/gid/mapped_uid/mapped_gid for ownership

set -eu

SHARED_VOLPATH="{{ shared_volpath }}"
HOSTNAME="{{ hostname }}"
UID_VALUE="{{ uid }}"
GID_VALUE="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

log() { echo "$@" >&2; }

is_defined() {
  [ -n "$1" ] && [ "$1" != "NOT_DEFINED" ]
}

sanitize_name() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

# Calculate effective UID/GID (same logic as 150)
EFFECTIVE_UID="$UID_VALUE"
EFFECTIVE_GID="$GID_VALUE"

if is_defined "$MAPPED_UID"; then
  EFFECTIVE_UID="$MAPPED_UID"
fi
if is_defined "$MAPPED_GID"; then
  EFFECTIVE_GID="$MAPPED_GID"
fi

if ! is_defined "$SHARED_VOLPATH"; then
  log "shared_volpath not defined - no volumes created, skipping pre-start uploads"
  echo '[{"id":"pre_start_files_uploaded","value":"false"}]'
  exit 0
fi

if ! is_defined "$HOSTNAME"; then
  log "Error: hostname is required"
  exit 1
fi

SAFE_HOST=$(sanitize_name "$HOSTNAME")
FILES_WRITTEN=0

# Write file to volume directory
# Arguments: content, path, label
# Returns: 0 if written, 1 if skipped (absolute path or error)
write_pre_start_file() {
  content="$1"
  path="$2"
  label="$3"

  if ! is_defined "$content" || ! is_defined "$path"; then
    return 0  # Skip if not defined
  fi

  # Check if path uses volume:filename format
  case "$path" in
    *:*)
      # Extract volume_key and filename
      volume_key=$(echo "$path" | cut -d':' -f1)
      filename=$(echo "$path" | cut -d':' -f2-)

      if [ -z "$volume_key" ] || [ -z "$filename" ]; then
        log "Warning: Invalid path format '$path' for $label, skipping"
        return 1
      fi

      # Compute target directory
      safe_key=$(sanitize_name "$volume_key")
      target_dir="${SHARED_VOLPATH}/volumes/${SAFE_HOST}/${safe_key}"
      target_path="${target_dir}/${filename}"

      # Verify directory exists (should have been created by 150)
      if [ ! -d "$target_dir" ]; then
        log "Warning: Volume directory '$target_dir' not found for $label, skipping"
        return 1
      fi

      # Skip if file already exists (preserve existing configuration)
      if [ -f "$target_path" ]; then
        log "Skipping $label: $target_path already exists"
        return 0
      fi

      # Create subdirectories if filename contains path
      target_subdir=$(dirname "$target_path")
      if [ "$target_subdir" != "$target_dir" ]; then
        mkdir -p "$target_subdir"
        if is_defined "$EFFECTIVE_UID" && is_defined "$EFFECTIVE_GID"; then
          chown "$EFFECTIVE_UID:$EFFECTIVE_GID" "$target_subdir" 2>/dev/null || true
        fi
      fi

      # Decode and write file
      log "Writing $label to $target_path..."
      echo "$content" | base64 -d > "$target_path"
      if is_defined "$EFFECTIVE_UID" && is_defined "$EFFECTIVE_GID"; then
        chown "$EFFECTIVE_UID:$EFFECTIVE_GID" "$target_path" 2>/dev/null || true
      fi
      log "  Success: $target_path"
      FILES_WRITTEN=$((FILES_WRITTEN + 1))
      return 0
      ;;
    /*)
      # Absolute path - skip, should be handled post-start
      log "Note: Absolute path '$path' for $label will be handled post-start"
      return 1
      ;;
    *)
      log "Warning: Unrecognized path format '$path' for $label, skipping"
      return 1
      ;;
  esac
}

# Process all file uploads
write_pre_start_file "{{ addon_content }}" "{{ addon_path }}" "addon config"
write_pre_start_file "{{ app_content0 }}" "{{ app_path0 }}" "app config 1"
write_pre_start_file "{{ app_content1 }}" "{{ app_path1 }}" "app config 2"
write_pre_start_file "{{ app_content2 }}" "{{ app_path2 }}" "app config 3"
write_pre_start_file "{{ app_content3 }}" "{{ app_path3 }}" "app config 4"

log "Pre-start file upload complete: $FILES_WRITTEN files written"

# Output results
if [ "$FILES_WRITTEN" -gt 0 ]; then
  echo '[{"id":"pre_start_files_uploaded","value":"true"}]'
else
  echo '[{"id":"pre_start_files_uploaded","value":"false"}]'
fi
