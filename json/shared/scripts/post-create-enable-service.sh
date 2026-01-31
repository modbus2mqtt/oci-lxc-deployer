#!/bin/sh
# Create and enable service (runs inside the container)
#
# This script creates and enables a system service for a command/application by:
# 1. Creating a system user for the service (if username/uid/gid provided)
# 2. Creating service directories and setting ownership
# 3. Creating service configuration file (OpenRC or systemd)
# 4. Enabling and starting the service
# 5. Configuring privileged port binding if needed
#
# Supports both Alpine Linux (OpenRC) and Debian/Ubuntu (systemd)
#
# Requires:
#   - command: Command name (also used as service name) (required)
#   - command_args: Command line arguments (optional)
#   - username: Username for service (optional, defaults to command name)
#   - uid: User ID (optional)
#   - group: Group name (optional)
#   - owned_paths: Space-separated paths to own (optional)
#   - bind_privileged_port: Allow binding to privileged ports (80, 443, etc.) (optional)
#
# Output: JSON to stdout (errors to stderr)

COMMAND="{{ command }}"
USERNAME_PARAM="{{ username }}"
USER_ID="{{ uid }}"
GROUP_NAME="{{ group }}"
OWNED_PATHS="{{ owned_paths }}"
BIND_PRIVILEGED_PORT="{{ bind_privileged_port }}"

if [ -z "$COMMAND" ]; then
  echo "Missing command" >&2
  exit 2
fi

set -eu

SERVICE_NAME="$COMMAND"
# Use username parameter if provided, otherwise use command as username
if [ -n "$USERNAME_PARAM" ] && [ "$USERNAME_PARAM" != "" ]; then
  USERNAME="$USERNAME_PARAM"
else
  USERNAME="$COMMAND"
fi
HOME_DIR="/home/$USERNAME"
DATA_DIR="/var/lib/$SERVICE_NAME"
SECURE_DIR="/etc/$SERVICE_NAME/secure"
LOGFILE="/var/log/$SERVICE_NAME.log"
COMMAND_ARGS="{{ command_args }}"

# Detect service manager
if command -v rc-service >/dev/null 2>&1; then
  # Alpine Linux with OpenRC
  SERVICE_CMD="rc-service"
  SERVICE_ENABLE_CMD="rc-update add"
  SERVICE_STATUS_CMD="rc-service status"
  USE_OPENRC=true
elif command -v systemctl >/dev/null 2>&1; then
  # Debian/Ubuntu with systemd
  SERVICE_CMD="systemctl"
  SERVICE_ENABLE_CMD="systemctl enable"
  SERVICE_STATUS_CMD="systemctl status"
  USE_OPENRC=false
else
  echo "Error: No supported service manager found (rc-service or systemctl)" >&2
  exit 1
fi

# Always ensure user and group exist (even if service already exists)
# Create group if specified and doesn't exist
if [ -n "$GROUP_NAME" ]; then
  if ! getent group "$GROUP_NAME" >/dev/null 2>&1; then
    if [ "$USE_OPENRC" = "true" ]; then
      addgroup "$GROUP_NAME"
    else
      groupadd "$GROUP_NAME"
    fi
  fi
  USER_GROUP="$GROUP_NAME"
else
  USER_GROUP="$USERNAME"
  if ! getent group "$USER_GROUP" >/dev/null 2>&1; then
    if [ "$USE_OPENRC" = "true" ]; then
      addgroup "$USER_GROUP"
    else
      groupadd "$USER_GROUP"
    fi
  fi
fi

# Create user if doesn't exist (always check, even if service exists)
# Special case: if username is "root", root already exists, skip creation
if [ "$USERNAME" = "root" ]; then
  echo "User 'root' already exists, skipping creation" >&2
elif ! id -u "$USERNAME" >/dev/null 2>&1; then
  if [ "$USE_OPENRC" = "true" ]; then
    if [ -n "$USER_ID" ]; then
      adduser -D -h "$HOME_DIR" -s /sbin/nologin -G "$USER_GROUP" -u "$USER_ID" "$USERNAME"
    else
      adduser -D -h "$HOME_DIR" -s /sbin/nologin -G "$USER_GROUP" "$USERNAME"
    fi
  else
    if [ -n "$USER_ID" ]; then
      useradd -r -d "$HOME_DIR" -s /usr/sbin/nologin -g "$USER_GROUP" -u "$USER_ID" "$USERNAME"
    else
      useradd -r -d "$HOME_DIR" -s /usr/sbin/nologin -g "$USER_GROUP" "$USERNAME"
    fi
  fi
fi

# Create directories (always ensure they exist with correct ownership)
mkdir -p "$HOME_DIR" "$DATA_DIR" "$SECURE_DIR"
chown "$USERNAME:$USER_GROUP" "$HOME_DIR" "$DATA_DIR"
chown "$USERNAME:$USER_GROUP" "$SECURE_DIR"
chmod 700 "$SECURE_DIR"

# Create log file (always ensure it exists with correct ownership)
touch "$LOGFILE"
chown "$USERNAME:$USER_GROUP" "$LOGFILE"

# Set ownership for owned_paths (always ensure correct ownership)
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

# Check if service already exists
SERVICE_EXISTS=false
if [ "$USE_OPENRC" = "true" ]; then
  if [ -f "/etc/init.d/$SERVICE_NAME" ]; then
    SERVICE_EXISTS=true
  fi
else
  if systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
    SERVICE_EXISTS=true
  fi
fi

# If service doesn't exist, create it
if [ "$SERVICE_EXISTS" = "false" ]; then

  # Find command path
  COMMAND_PATH=$(command -v "$COMMAND" 2>/dev/null || echo "/usr/bin/$COMMAND")

  if [ "$USE_OPENRC" = "true" ]; then
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
  else
    # Create systemd service file
    cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=$SERVICE_NAME service
After=network.target

[Service]
Type=simple
User=$USERNAME
Group=$USER_GROUP
ExecStart=$COMMAND_PATH $COMMAND_ARGS
Restart=always
RestartSec=10
StandardOutput=append:$LOGFILE
StandardError=append:$LOGFILE
Environment=HOME=$HOME_DIR
Environment=DATA=$DATA_DIR
Environment=SECURE=$SECURE_DIR

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload >&2
  fi

  # Set CAP_NET_BIND_SERVICE capability if requested (allows binding to ports < 1024)
  if [ "$BIND_PRIVILEGED_PORT" = "true" ]; then
    # Install libcap if not available (needed for setcap)
    if ! command -v setcap >/dev/null 2>&1; then
      if [ "$USE_OPENRC" = "true" ]; then
        apk add --no-cache libcap >&2
      else
        apt-get update -qq >&2 && apt-get install -y --no-install-recommends libcap2-bin >&2
      fi
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
fi

# Enable and start service
if [ "$USE_OPENRC" = "true" ]; then
  rc-update add "$SERVICE_NAME" default >&2
  rc-service "$SERVICE_NAME" start >&2
else
  systemctl enable "$SERVICE_NAME" >&2
  systemctl start "$SERVICE_NAME" >&2
fi

# Verify that service is running
SERVICE_RUNNING=false
if [ "$USE_OPENRC" = "true" ]; then
  # For OpenRC, check if process is running (more reliable than rc-service status)
  # Check PID file first, then fall back to process check
  PIDFILE="/run/${SERVICE_NAME}.pid"
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      SERVICE_RUNNING=true
    fi
  fi
  # If PID file check failed, check if process is running by command name
  if [ "$SERVICE_RUNNING" = "false" ]; then
    # Check if the command process is running (exclude grep itself)
    if ps aux | grep -v "grep" | grep -q "$COMMAND"; then
      SERVICE_RUNNING=true
    fi
  fi
else
  # For systemd, use is-active which is more reliable than status
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    SERVICE_RUNNING=true
  fi
fi

if [ "$SERVICE_RUNNING" = "false" ]; then
  echo "Error: $SERVICE_NAME service failed to start" >&2
  # Try to get more information about the failure
  if [ -f "/var/log/$SERVICE_NAME.log" ]; then
    echo "=== Service Logs ===" >&2
    echo "Last 20 lines of /var/log/$SERVICE_NAME.log:" >&2
    tail -20 "/var/log/$SERVICE_NAME.log" >&2 || true
    echo "" >&2
  fi
  echo "=== Process Check ===" >&2
  ps aux | grep -i "$SERVICE_NAME" | grep -v grep >&2 || echo "No $SERVICE_NAME process found" >&2
  echo "" >&2
  
  if [ "$USE_OPENRC" = "true" ]; then
    echo "=== Service Status ===" >&2
    rc-service "$SERVICE_NAME" status >&2 || true
  else
    echo "=== Service Status ===" >&2
    systemctl status "$SERVICE_NAME" >&2 || true
    echo "=== Journal Logs ===" >&2
    journalctl -u "$SERVICE_NAME" -n 20 --no-pager >&2 || true
  fi
  exit 1
fi

# Output logfile path as JSON
echo "[{\"id\": \"logfile_path\", \"value\": \"$LOGFILE\"}]"

exit 0

