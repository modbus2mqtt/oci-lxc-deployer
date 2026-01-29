#!/bin/sh
# Install Docker in LXC container
#
# This script installs Docker by:
# 1. Auto-detecting OS type from /etc/os-release
# 2. Using appropriate package manager (apk for Alpine, apt for Debian/Ubuntu)
# 3. Installing Docker packages
# 4. Configuring Docker daemon
# 5. Starting Docker service
#
# Supports both Alpine Linux (apk) and Debian/Ubuntu (apt)
#
# Requires:
#   - ostype: OS type fallback if /etc/os-release not available (optional)
#
# Output: JSON to stdout (errors to stderr)

# Auto-detect OS type from /etc/os-release
# Falls back to {{ ostype }} parameter if os-release is not available
if [ -f /etc/os-release ]; then
  # Source the file to get ID variable
  . /etc/os-release
  OSTYPE="$ID"
else
  # Fallback to template parameter
  OSTYPE="{{ ostype }}"
  if [ -z "$OSTYPE" ] || [ "$OSTYPE" = "" ]; then
    OSTYPE="alpine"
  fi
fi

case "$OSTYPE" in
  alpine)
    echo "Installing Docker for Alpine Linux..." >&2
    
    # Install Docker packages
    # Note: In LXC containers, Docker runs as root (not rootless)
    apk add --no-cache docker docker-cli docker-compose >&2
    
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
    
    # Install prerequisites
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >&2
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
      lsb-release >&2
    
    # Add Docker's official GPG key
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg >&2
    chmod a+r /etc/apt/keyrings/docker.gpg
    
    # Detect OS version
    if [ -f /etc/os-release ]; then
      . /etc/os-release
      VERSION_CODENAME="$VERSION_CODENAME"
    else
      VERSION_CODENAME="bookworm"  # Default for Debian
    fi
    
    # Set up Docker repository
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
      $VERSION_CODENAME stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    # Install Docker packages
    # Note: In LXC containers, Docker runs as root (not rootless)
    apt-get update -qq >&2
    apt-get install -y --no-install-recommends \
      docker-ce \
      docker-ce-cli \
      containerd.io \
      docker-buildx-plugin \
      docker-compose-plugin >&2
    
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
    echo "Error: Unsupported ostype: $OSTYPE" >&2
    echo "Supported types: alpine, debian, ubuntu" >&2
    exit 3
    ;;
esac

echo "Docker installed successfully" >&2
echo '[{"id": "docker_installed", "value": "true"}]'
