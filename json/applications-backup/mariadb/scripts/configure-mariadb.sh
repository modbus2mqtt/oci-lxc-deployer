#!/bin/sh
# Configure MariaDB
# Inputs (templated):
#   {{ bind_address }} - bind address (e.g., 127.0.0.1 or 0.0.0.0)
#   {{ datadir }} - data directory path

BIND_ADDRESS="{{ bind_address }}"
DATADIR="{{ datadir }}"

set -eu

# Determine config file location (Alpine 3.9+ uses /etc/my.cnf.d/mariadb-server.cnf)
CONFIG_FILE="/etc/my.cnf.d/mariadb-server.cnf"
if [ ! -f "$CONFIG_FILE" ]; then
  # Fallback to /etc/mysql/my.cnf for older Alpine versions
  CONFIG_FILE="/etc/mysql/my.cnf"
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: MariaDB configuration file not found" >&2
    exit 1
  fi
fi

# Create config directory if it doesn't exist
mkdir -p "$(dirname "$CONFIG_FILE")"

# Configure bind address
echo "Configuring bind address to $BIND_ADDRESS..." >&2
if grep -q "^bind-address" "$CONFIG_FILE" 2>/dev/null; then
  # Update existing bind-address
  sed -i "s|^bind-address.*|bind-address = $BIND_ADDRESS|g" "$CONFIG_FILE"
else
  # Add bind-address to [mysqld] section
  if grep -q "^\[mysqld\]" "$CONFIG_FILE" 2>/dev/null; then
    sed -i "/^\[mysqld\]/a bind-address = $BIND_ADDRESS" "$CONFIG_FILE"
  else
    echo "[mysqld]" >> "$CONFIG_FILE"
    echo "bind-address = $BIND_ADDRESS" >> "$CONFIG_FILE"
  fi
fi

# Configure datadir if different from default
if [ "$DATADIR" != "/var/lib/mysql" ]; then
  echo "Configuring data directory to $DATADIR..." >&2
  if grep -q "^datadir" "$CONFIG_FILE" 2>/dev/null; then
    sed -i "s|^datadir.*|datadir = $DATADIR|g" "$CONFIG_FILE"
  else
    if grep -q "^\[mysqld\]" "$CONFIG_FILE" 2>/dev/null; then
      sed -i "/^\[mysqld\]/a datadir = $DATADIR" "$CONFIG_FILE"
    else
      echo "[mysqld]" >> "$CONFIG_FILE"
      echo "datadir = $DATADIR" >> "$CONFIG_FILE"
    fi
  fi
fi

# Disable skip-networking to allow remote connections
echo "Disabling skip-networking to allow remote connections..." >&2
if grep -q "^skip-networking" "$CONFIG_FILE" 2>/dev/null; then
  # Comment out skip-networking if it's enabled
  sed -i "s|^skip-networking|#skip-networking|g" "$CONFIG_FILE"
elif grep -q "^#skip-networking" "$CONFIG_FILE" 2>/dev/null; then
  # Already commented out, nothing to do
  echo "skip-networking is already disabled" >&2
fi

echo "MariaDB configuration updated" >&2

# Restart service if it's running to apply configuration changes
if rc-service mariadb status >/dev/null 2>&1; then
  echo "Restarting MariaDB to apply configuration changes..." >&2
  rc-service mariadb restart >&2
fi

exit 0
