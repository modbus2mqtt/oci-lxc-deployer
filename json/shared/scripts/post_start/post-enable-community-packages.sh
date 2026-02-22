#!/bin/sh
# Enable Alpine Linux community repository (runs inside the container)
# Library: pkg-common.sh (prepended automatically)
#
# This script enables the Alpine community repository using the pkg-common.sh library.
# The library handles network wait, repository configuration, and cache update.
set -eu

# pkg_add_alpine_community handles everything:
# - OS detection (validates Alpine)
# - Network wait
# - Repository configuration
# - Cache update
pkg_add_alpine_community

exit 0
