#!/bin/sh
# Set package manager mirrors for Alpine Linux (apk) or Debian/Ubuntu (apt)
#
# This script configures package manager mirrors by:
# 1. Detecting OS type (Alpine or Debian/Ubuntu)
# 2. Configuring appropriate mirror repositories
# 3. Updating package manager cache
#
# Requires:
#   - ostype: Operating system type (alpine, debian, ubuntu) (optional, defaults to alpine)
#   - alpine_mirror: Alpine Linux mirror URL (optional)
#   - debian_mirror: Debian/Ubuntu mirror URL (optional)
#
# Script is idempotent and can be run multiple times safely.
#
# Output: JSON to stdout (errors to stderr)

OSTYPE="{{ ostype }}"
ALPINE_MIRROR="{{ alpine_mirror }}"
DEBIAN_MIRROR="{{ debian_mirror }}"

# Default to alpine if not specified
if [ -z "$OSTYPE" ] || [ "$OSTYPE" = "" ]; then
  OSTYPE="alpine"
fi

case "$OSTYPE" in
  alpine)
    if [ -n "$ALPINE_MIRROR" ] && [ "$ALPINE_MIRROR" != "" ]; then
      # Get Alpine version
      if [ -f /etc/alpine-release ]; then
        ALPINE_VERSION=$(cat /etc/alpine-release | cut -d. -f1,2)
        ALPINE_VER="v${ALPINE_VERSION}"
        
        # Backup original repositories if not already backed up
        if [ -f /etc/apk/repositories ] && [ ! -f /etc/apk/repositories.orig ]; then
          cp /etc/apk/repositories /etc/apk/repositories.orig >&2
        fi
        
        # Set new mirror repositories
        cat > /etc/apk/repositories <<EOF
${ALPINE_MIRROR}/${ALPINE_VER}/main
${ALPINE_MIRROR}/${ALPINE_VER}/community
EOF
        echo "Configured Alpine APK mirror: $ALPINE_MIRROR" >&2
        echo "Alpine version: $ALPINE_VERSION" >&2
        echo "Repository URLs:" >&2
        echo "  ${ALPINE_MIRROR}/${ALPINE_VER}/main" >&2
        echo "  ${ALPINE_MIRROR}/${ALPINE_VER}/community" >&2
        echo "Successfully configured Alpine APK repositories" >&2
      else
        echo "Warning: /etc/alpine-release not found, cannot determine Alpine version" >&2
      fi
    else
      echo "Alpine mirror not set, using default repositories" >&2
    fi
    ;;
  debian|ubuntu)
    if [ -n "$DEBIAN_MIRROR" ] && [ "$DEBIAN_MIRROR" != "" ]; then
      # Detect Debian/Ubuntu version
      if [ -f /etc/debian_version ]; then
        DEBIAN_VERSION=$(cat /etc/debian_version)
        # Try to get codename from /etc/os-release
        if [ -f /etc/os-release ]; then
          . /etc/os-release
          CODENAME="$VERSION_CODENAME"
        fi
        
        # If no codename found, try to detect from version
        if [ -z "$CODENAME" ] || [ "$CODENAME" = "" ]; then
          case "$DEBIAN_VERSION" in
            *bookworm*) CODENAME="bookworm" ;;
            *bullseye*) CODENAME="bullseye" ;;
            *buster*) CODENAME="buster" ;;
            *) CODENAME="stable" ;;
          esac
        fi
        
        # Backup original sources.list if not already backed up
        if [ -f /etc/apt/sources.list ] && [ ! -f /etc/apt/sources.list.orig ]; then
          cp /etc/apt/sources.list /etc/apt/sources.list.orig >&2
        fi
        
        # Disable debian.sources if it exists (modern Debian uses this by default, but we use sources.list)
        if [ -f /etc/apt/sources.list.d/debian.sources ]; then
          if [ ! -f /etc/apt/sources.list.d/debian.sources.orig ]; then
            cp /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list.d/debian.sources.orig >&2
          fi
          # Remove or disable debian.sources to avoid duplicate entries
          rm -f /etc/apt/sources.list.d/debian.sources >&2
          echo "Disabled /etc/apt/sources.list.d/debian.sources to avoid duplicate entries" >&2
        fi
        
        # Set new mirror in sources.list
        # Handle deb.debian.org specially (it uses /debian path for security)
        if echo "$DEBIAN_MIRROR" | grep -q "deb.debian.org"; then
          cat > /etc/apt/sources.list <<EOF
deb ${DEBIAN_MIRROR} ${CODENAME} main
deb ${DEBIAN_MIRROR} ${CODENAME}-updates main
deb ${DEBIAN_MIRROR}-security ${CODENAME}-security main
EOF
        else
          # For other mirrors, assume standard structure
          cat > /etc/apt/sources.list <<EOF
deb ${DEBIAN_MIRROR} ${CODENAME} main
deb ${DEBIAN_MIRROR} ${CODENAME}-updates main
deb ${DEBIAN_MIRROR} ${CODENAME}-security main
EOF
        fi
        echo "Configured Debian/Ubuntu APT mirror: $DEBIAN_MIRROR" >&2
        echo "Using codename: $CODENAME" >&2
        echo "Repository entries:" >&2
        echo "  deb ${DEBIAN_MIRROR} ${CODENAME} main" >&2
        echo "  deb ${DEBIAN_MIRROR} ${CODENAME}-updates main" >&2
        if echo "$DEBIAN_MIRROR" | grep -q "deb.debian.org"; then
          echo "  deb ${DEBIAN_MIRROR}-security ${CODENAME}-security main" >&2
        else
          echo "  deb ${DEBIAN_MIRROR} ${CODENAME}-security main" >&2
        fi
        echo "Successfully configured Debian/Ubuntu APT repositories" >&2
      else
        echo "Warning: /etc/debian_version not found, cannot determine Debian version" >&2
      fi
    else
      echo "Debian mirror not set, using default repositories" >&2
    fi
    ;;
  *)
    echo "Warning: Unsupported ostype: $OSTYPE" >&2
    ;;
esac

exit 0

