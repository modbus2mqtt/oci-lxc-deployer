#!/bin/sh
# Enable Alpine Linux community repository (runs inside the container)
set -eu

# Get Alpine version
ALPINE_VERSION=$(cat /etc/alpine-release | cut -d. -f1,2)

# Enable community repository by uncommenting the line in /etc/apk/repositories
if [ -f /etc/apk/repositories ]; then
  # Uncomment community repository line if it exists and is commented
  sed -i "s|^#.*/v${ALPINE_VERSION}/community|http://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/community|" /etc/apk/repositories || true
  
  # If the line doesn't exist, add it
  if ! grep -q "community" /etc/apk/repositories; then
    echo "http://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/community" >> /etc/apk/repositories
  fi
  
  # Update package index
  apk update >&2
else
  echo "Error: /etc/apk/repositories not found" >&2
  exit 1
fi

exit 0
