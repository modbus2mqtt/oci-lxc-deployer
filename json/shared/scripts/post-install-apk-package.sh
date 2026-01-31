#!/bin/sh
# Install packages inside LXC container (runs inside the container)
# Library: pkg-common.sh (prepended automatically)
#
# This script installs packages using the pkg-common.sh library which:
# - Waits for network connectivity with retry logic
# - Auto-detects OS type (Alpine/Debian/Ubuntu)
# - Updates package cache only once per session
# - Installs packages using appropriate package manager
#
# Requires:
#   - packages: Space-separated list of packages (e.g., "openssh curl") (required)
#
# Output: JSON to stdout (errors to stderr)
set -eu

PACKAGES="{{ packages }}"

if [ -z "$PACKAGES" ]; then
  echo "Missing packages" >&2
  exit 2
fi

# pkg_install handles: OS detection, network wait, cache update, installation
# shellcheck disable=SC2086
pkg_install $PACKAGES

exit 0
