#!/bin/sh
# Install Node.js application globally via npm (runs inside the container)
# Inputs (templated):
#   {{ package }}  - npm package name
#   {{ version }}  - version to install (default: latest)

PACKAGE="{{ package }}"
VERSION="{{ version }}"

if [ -z "$PACKAGE" ]; then
  echo "Missing package name" >&2
  exit 2
fi

# Check if npm is installed
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is not installed" >&2
  exit 1
fi

set -eu

# Install the package globally
if [ "$VERSION" = "latest" ] || [ -z "$VERSION" ]; then
  npm install -g "$PACKAGE"
else
  npm install -g "$PACKAGE@$VERSION"
fi

# Output path to node-red's settings.json
SETTINGS_PATH="/root/.node-red/settings.js"
echo "settings_path=$SETTINGS_PATH"

exit 0



