#!/bin/sh
set -e
# Install Docker in LXC container
# Library: pkg-common.sh (prepended automatically)
#
# This script installs Docker using the pkg-common.sh library for:
# - Network readiness check with retry
# - OS detection (Alpine/Debian/Ubuntu)
# - Package installation with automatic cache management
#
# Docker configuration and service management is handled directly.
#
# Supports both Alpine Linux (apk) and Debian/Ubuntu (apt)
#
# Output: JSON to stdout (errors to stderr)

# Detect OS using library function
pkg_detect_os || exit 1

case "$PKG_OS_TYPE" in
  alpine)
    echo "Installing Docker for Alpine Linux..." >&2

    # Install Docker packages using library
    pkg_install docker docker-cli docker-compose

    # Configure Docker daemon
    mkdir -p /etc/docker
    cat > /etc/docker/daemon.json <<EOF
{
  "storage-driver": "overlay2",
  "userland-proxy": false
}
EOF

    # Enable and start Docker service
    rc-update add docker default >&2
    rc-service docker start >&2
    ;;

  debian|ubuntu)
    echo "Installing Docker for Debian/Ubuntu..." >&2

    # Install prerequisites using library
    pkg_install ca-certificates curl gnupg lsb-release

    # Add Docker's official GPG key with retry
    install -m 0755 -d /etc/apt/keyrings
    pkg_curl_retry "https://download.docker.com/linux/debian/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg >&2
    chmod a+r /etc/apt/keyrings/docker.gpg

    # Get version codename using library
    VERSION_CODENAME=$(pkg_get_version_codename)
    if [ -z "$VERSION_CODENAME" ]; then
      VERSION_CODENAME="bookworm"  # Default for Debian
    fi

    # Set up Docker repository
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
      $VERSION_CODENAME stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null

    # Force cache update after adding new repository
    pkg_update_cache true

    # Install Docker packages
    pkg_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    # Configure Docker daemon
    mkdir -p /etc/docker
    cat > /etc/docker/daemon.json <<EOF
{
  "storage-driver": "overlay2",
  "userland-proxy": false
}
EOF

    # Enable and start Docker service
    systemctl enable docker >&2
    systemctl start docker >&2
    ;;

  *)
    echo "Error: Unsupported OS type: $PKG_OS_TYPE" >&2
    echo "Supported types: alpine, debian, ubuntu" >&2
    exit 3
    ;;
esac

echo "Docker installed successfully" >&2
echo '[{"id": "docker_installed", "value": "true"}]'
