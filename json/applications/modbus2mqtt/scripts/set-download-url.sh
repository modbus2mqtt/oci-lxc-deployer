#!/bin/sh
set -e

owner="modbus2mqtt"
repo="modbus2mqtt"

# Check if wget is available
if ! command -v wget >/dev/null 2>&1; then
  echo "Error: wget command not found" >&2
  exit 1
fi

# Fetch GitHub API response
API_URL="https://api.github.com/repos/$owner/$repo/releases/latest"
API_RESPONSE=$(wget -q -O - "$API_URL" 2>&1) || {
  echo "Error: Failed to fetch GitHub API: $API_RESPONSE" >&2
  exit 1
}

# Extract package URL from API response
packagerurl=$(echo "$API_RESPONSE" | \
  awk '
    /"name":/ && /x86_64\.apk"/ { found=1 }
    found && /"browser_download_url":/ {
      gsub(/.*: *"/, "", $0)
      gsub(/",?$/, "", $0)
      print $0
      exit
    }
  ')

# Validate that package URL was found
if [ -z "$packagerurl" ] || [ "$packagerurl" = "" ]; then
  echo "Error: Failed to extract package URL from GitHub API response" >&2
  exit 1
fi

# Set public key URL
packagerpubkeyurl="https://github.com/$owner/$repo/releases/latest/download/packager.rsa.pub"

# Output JSON (only on success)
echo '[{ "id": "packageurl", "value": "'$packagerurl'" }, { "id": "packagerpubkeyurl", "value": "'$packagerpubkeyurl'" }]'