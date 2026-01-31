#!/bin/sh
# Download and install APK package on the LXC container
# Inputs (templated):
#   {{ packageurl }} - URL of the APK package
#   {{ packagerpubkeyurl }} - URL of the public key for verifying the package
# Outputs: JSON with packageurl and packagerpubkeyurl (for compatibility)

set -e

PACKAGEURL="{{ packageurl }}"
PACKAGERPUBKEYURL="{{ packagerpubkeyurl }}"

# Validate inputs
if [ -z "$PACKAGEURL" ] || [ "$PACKAGEURL" = "" ]; then
  echo "Error: packageurl is empty" >&2
  exit 1
fi

if [ -z "$PACKAGERPUBKEYURL" ] || [ "$PACKAGERPUBKEYURL" = "" ]; then
  echo "Error: packagerpubkeyurl is empty" >&2
  exit 1
fi

# Check if wget is available
if ! command -v wget >/dev/null 2>&1; then
  echo "Error: wget command not found" >&2
  exit 1
fi

# Download package
echo "Downloading package from $PACKAGEURL..." >&2
if ! wget -O packagefile.apk "$PACKAGEURL" >&2; then
  echo "Error: Failed to download package from $PACKAGEURL" >&2
  exit 1
fi

# Download public key
echo "Downloading public key from $PACKAGERPUBKEYURL..." >&2
KEY=$(wget -q -O - "$PACKAGERPUBKEYURL" 2>&1) || {
  echo "Error: Failed to download public key from $PACKAGERPUBKEYURL" >&2
  exit 1
}

# Install package
echo "Installing package..." >&2
if ! apk add --no-progress --allow-untrusted --key "$KEY" ./packagefile.apk >&2; then
  EXIT_CODE=$?
  echo "Error: Failed to install package (exit code: $EXIT_CODE)" >&2
  exit $EXIT_CODE
fi

echo "Package installed successfully" >&2

# Clean up downloaded file
rm -f ./packagefile.apk

# Output JSON for compatibility (though outputs are already set by template)
exit 0


