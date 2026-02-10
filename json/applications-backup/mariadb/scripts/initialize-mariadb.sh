#!/bin/sh
# Initialize MariaDB data directory
# Inputs (templated):
#   {{ datadir }} - data directory path

DATADIR="{{ datadir }}"

set -eu

# Ensure mysql user exists
if ! id -u mysql >/dev/null 2>&1; then
  echo "Error: mysql user does not exist" >&2
  exit 1
fi

# Create data directory if it doesn't exist
if [ ! -d "$DATADIR" ]; then
  mkdir -p "$DATADIR"
fi

# Set ownership to mysql user
chown -R mysql:mysql "$DATADIR"

# Initialize database if not already initialized
if [ ! -d "$DATADIR/mysql" ]; then
  echo "Initializing MariaDB data directory in $DATADIR..." >&2
  mariadb-install-db --user=mysql --datadir="$DATADIR" >&2
  
  if [ $? -ne 0 ]; then
    echo "Error: Failed to initialize MariaDB data directory" >&2
    exit 1
  fi
  
  echo "MariaDB data directory initialized successfully" >&2
else
  echo "MariaDB data directory already initialized" >&2
fi
exit 0
