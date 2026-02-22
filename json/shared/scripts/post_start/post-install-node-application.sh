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

# Install the package globally (ignore exit code, verify with npm list)
if [ "$VERSION" = "latest" ] || [ -z "$VERSION" ]; then
  npm install -g "$PACKAGE" >&2 || true
else
  npm install -g "$PACKAGE@$VERSION" >&2 || true
fi

# Verify installation succeeded
if [ "$VERSION" = "latest" ] || [ -z "$VERSION" ]; then
  # Just check if package is installed
  if ! npm list -g "$PACKAGE" >/dev/null ;then
    echo "Error: $PACKAGE was not installed" >&2
    exit 1
  fi
else
  # Check if specific version is installed
  if ! npm list -g "$PACKAGE@$VERSION" >/dev/null ;then
    echo "Error: $PACKAGE@$VERSION was not installed" >&2
    exit 1
  fi
fi

echo "Successfully installed $PACKAGE" >&2

#  (no outputs needed)

exit 0



