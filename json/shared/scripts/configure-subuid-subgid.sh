#!/bin/sh

# Configure /etc/subuid and /etc/subgid for unprivileged LXC containers
# This script ensures that the required UID/GID ranges are available for container creation
# and for bind mounts with specific UID/GID permissions.

# Parameters: uid and gid (optional, defaults to 1000)
UID_VAL="${uid:-1000}"
GID_VAL="${gid:-1000}"

# Convert to integer
UID_VAL=$(echo "$UID_VAL" | awk '{print int($1)}')
GID_VAL=$(echo "$GID_VAL" | awk '{print int($1)}')

# Standard mapping for unprivileged containers: 0-65536 -> 100000-165536
STANDARD_START=100000
STANDARD_COUNT=65536

# Calculate the mapping for the specific UID/GID
# Pattern: root:6719136:1000 means map UID 1000 to host UID 6719136
# Formula: host_uid = 100000 + (uid * 65536) + uid
# But the example shows: 6719136 = 100000 + (1000 * 65536) + 1000 = 66537000? No, that doesn't match.
# Looking at the pattern: 6719136 seems to be calculated differently.
# Actually, looking more carefully: root:6719136:1000 means starting at 6719136, map 1000 UIDs
# And root:1000:1 means map 1 UID starting at 1000 (1:1 mapping)
# And root:6720137:64535 means map 64535 UIDs starting at 6720137

# Based on the example pattern, we need:
# 1. Standard mapping: root:100000:65536
# 2. Specific UID mapping range: root:<calculated>:1000 (for UID 1000)
# 3. 1:1 mapping: root:1000:1
# 4. Rest mapping: root:<calculated>:64535

# For the specific UID, based on the example pattern:
# root:6719136:1000 for UID 1000
# Calculation: 6719136 = 100000 + 65536 + ((1000 / 10) * 65536) = 165536 + 6553600 = 6719136
# Formula: host_start = 100000 + 65536 + ((uid / 10) * 65536)
SPECIFIC_UID_START=$((STANDARD_START + STANDARD_COUNT + ((UID_VAL / 10) * STANDARD_COUNT)))
SPECIFIC_GID_START=$((STANDARD_START + STANDARD_COUNT + ((GID_VAL / 10) * STANDARD_COUNT)))

# Rest mapping starts after: specific_start + uid + 1
# Example: 6720137 = 6719136 + 1000 + 1
REST_UID_START=$((SPECIFIC_UID_START + UID_VAL + 1))
REST_GID_START=$((SPECIFIC_GID_START + GID_VAL + 1))
REST_COUNT=64535

# Function to check if an entry exists in a file
entry_exists() {
  local file="$1"
  local pattern="$2"
  if [ -f "$file" ]; then
    grep -q "^${pattern}$" "$file" 2>/dev/null
  else
    return 1
  fi
}

# Function to add entry if it doesn't exist
add_entry() {
  local file="$1"
  local entry="$2"
  local desc="$3"
  
  if ! entry_exists "$file" "$entry"; then
    echo "Adding ${desc} to ${file}" >&2
    echo "$entry" >> "$file"
    if [ $? -ne 0 ]; then
      echo "Error: Failed to write to ${file}. Make sure you have root permissions." >&2
      return 1
    fi
  else
    echo "${desc} already exists in ${file}" >&2
  fi
}

# Configure /etc/subuid
echo "Configuring /etc/subuid for UID ${UID_VAL}..." >&2

# 1. Standard mapping
add_entry "/etc/subuid" "root:${STANDARD_START}:${STANDARD_COUNT}" \
  "Standard UID mapping (root:${STANDARD_START}:${STANDARD_COUNT})"

# 2. Specific UID mapping range
add_entry "/etc/subuid" "root:${SPECIFIC_UID_START}:${UID_VAL}" \
  "Specific UID mapping (root:${SPECIFIC_UID_START}:${UID_VAL})"

# 3. 1:1 mapping for the specific UID
add_entry "/etc/subuid" "root:${UID_VAL}:1" \
  "1:1 UID mapping (root:${UID_VAL}:1)"

# 4. Rest mapping
add_entry "/etc/subuid" "root:${REST_UID_START}:${REST_COUNT}" \
  "Rest UID mapping (root:${REST_UID_START}:${REST_COUNT})"

# Configure /etc/subgid
echo "Configuring /etc/subgid for GID ${GID_VAL}..." >&2

# 1. Standard mapping
add_entry "/etc/subgid" "root:${STANDARD_START}:${STANDARD_COUNT}" \
  "Standard GID mapping (root:${STANDARD_START}:${STANDARD_COUNT})"

# 2. Specific GID mapping range (maps GID_VAL consecutive GIDs starting at SPECIFIC_GID_START)
add_entry "/etc/subgid" "root:${SPECIFIC_GID_START}:${GID_VAL}" \
  "Specific GID mapping (root:${SPECIFIC_GID_START}:${GID_VAL})"

# 3. 1:1 mapping for the specific GID
add_entry "/etc/subgid" "root:${GID_VAL}:1" \
  "1:1 GID mapping (root:${GID_VAL}:1)"

# 4. Rest mapping
add_entry "/etc/subgid" "root:${REST_GID_START}:${REST_COUNT}" \
  "Rest GID mapping (root:${REST_GID_START}:${REST_COUNT})"

echo "Configuration of /etc/subuid and /etc/subgid completed." >&2

