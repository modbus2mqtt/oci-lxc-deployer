#!/bin/sh
# Create OpenRC service for an npm package (runs inside the container)
#
# This script creates an OpenRC service for a Node.js/npm application by:
# 1. Creating a system user for the service
# 2. Creating service directories and setting ownership
# 3. Creating OpenRC service configuration file
# 4. Enabling and starting the service
# 5. Configuring privileged port binding if needed
#
# Requires:
#   - command: Command name (also used as service and user name) (required)
#   - command_args: Command line arguments (optional)
#   - uid: User ID (optional)
#   - group: Group name (optional)
#   - owned_paths: Space-separated paths to own (optional)
#   - bind_privileged_port: Allow binding to privileged ports (80, 443, etc.) (optional)
#
# Output: JSON to stdout (errors to stderr)

COMMAND="{{ command }}"
USER_ID="{{ uid }}"
GROUP_NAME="{{ group }}"
OWNED_PATHS="{{ owned_paths }}"
BIND_PRIVILEGED_PORT="{{ bind_privileged_port }}"

if [ -z "$COMMAND" ]; then
  echo "Missing command" >&2
  exit 2
fi

# Check if openrc is installed
if ! command -v rc-service >/dev/null 2>&1; then
  echo "Error: OpenRC is not installed" >&2
  exit 1
fi

set -eu

SERVICE_NAME="$COMMAND"
USERNAME="$COMMAND"
HOME_DIR="/home/$USERNAME"
DATA_DIR="/var/lib/$SERVICE_NAME"
SECURE_DIR="/etc/$SERVICE_NAME/secure"
LOGFILE="/var/log/$SERVICE_NAME.log"
COMMAND_ARGS="{{ command_args }}"

# Create group if specified and doesn't exist
if [ -n "$GROUP_NAME" ]; then
  if ! getent group "$GROUP_NAME" >/dev/null 2>&1; then
    addgroup "$GROUP_NAME"
  fi
  USER_GROUP="$GROUP_NAME"
else
  USER_GROUP="$USERNAME"
  if ! getent group "$USER_GROUP" >/dev/null 2>&1; then
    addgroup "$USER_GROUP"
  fi
fi

# Create user if doesn't exist
# Special case: if username is "root", root already exists, skip creation
if [ "$USERNAME" = "root" ]; then
  echo "User 'root' already exists, skipping creation" >&2
elif ! id -u "$USERNAME" >/dev/null 2>&1; then
  if [ -n "$USER_ID" ]; then
    adduser -D -h "$HOME_DIR" -s /sbin/nologin -G "$USER_GROUP" -u "$USER_ID" "$USERNAME"
  else
    adduser -D -h "$HOME_DIR" -s /sbin/nologin -G "$USER_GROUP" "$USERNAME"
  fi
fi

# Create directories
mkdir -p "$HOME_DIR" "$DATA_DIR" "$SECURE_DIR"
chown "$USERNAME:$USER_GROUP" "$HOME_DIR" "$DATA_DIR"
chown "$USERNAME:$USER_GROUP" "$SECURE_DIR"
chmod 700 "$SECURE_DIR"

# Create log file
touch "$LOGFILE"
chown "$USERNAME:$USER_GROUP" "$LOGFILE"

# Set ownership for owned_paths
if [ -n "$OWNED_PATHS" ]; then
  for path in $OWNED_PATHS; do
    if [ -e "$path" ]; then
      chown "$USERNAME:$USER_GROUP" "$path"
      chmod u+rw "$path"
    else
      mkdir -p "$path"
      chown "$USERNAME:$USER_GROUP" "$path"
      chmod u+rwx "$path"
    fi
  done
fi

# Find command path
COMMAND_PATH=$(command -v "$COMMAND" 2>/dev/null || echo "/usr/bin/$COMMAND")

# Create OpenRC init script
cat > "/etc/init.d/$SERVICE_NAME" << EOF
#!/sbin/openrc-run

name="$SERVICE_NAME"
description="$SERVICE_NAME service"

command="$COMMAND_PATH"
command_args="$COMMAND_ARGS"
command_user="$USERNAME:$USER_GROUP"
command_background=true
pidfile="/run/\${RC_SVCNAME}.pid"
output_log="$LOGFILE"
error_log="$LOGFILE"

export HOME="$HOME_DIR"
export DATA="$DATA_DIR"
export SECURE="$SECURE_DIR"

depend() {
    need net
    after firewall
}

start_pre() {
    checkpath --directory --owner $USERNAME:$USER_GROUP --mode 0755 /run
}
EOF

chmod +x "/etc/init.d/$SERVICE_NAME"

# Set CAP_NET_BIND_SERVICE capability if requested (allows binding to ports < 1024)
if [ "$BIND_PRIVILEGED_PORT" = "true" ]; then
  # Install libcap if not available (needed for setcap)
  if ! command -v setcap >/dev/null 2>&1; then
    apk add --no-cache libcap >&2
  fi
  # Set capability to allow binding to privileged ports
  if command -v setcap >/dev/null 2>&1; then
    setcap 'cap_net_bind_service=+ep' "$COMMAND_PATH" >&2 || {
      echo "Warning: Failed to set CAP_NET_BIND_SERVICE capability. Service may not be able to bind to privileged ports." >&2
    }
  else
    echo "Warning: setcap not available after installation. Cannot set CAP_NET_BIND_SERVICE capability." >&2
  fi
fi

# Enable and start service
rc-update add "$SERVICE_NAME" default >&2
rc-service "$SERVICE_NAME" start >&2

# Output logfile path as JSON
echo "[{\"id\": \"logfile_path\", \"value\": \"$LOGFILE\"}]"

exit 0



