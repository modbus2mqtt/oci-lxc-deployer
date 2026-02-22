#!/bin/sh
# Start and enable Mosquitto service (runs inside the container)
# Supports both Alpine Linux (OpenRC) and Debian/Ubuntu (systemd)
set -eu

# Detect service manager
if command -v rc-service >/dev/null 2>&1; then
  # Alpine Linux with OpenRC
  SERVICE_CMD="rc-service"
  SERVICE_ENABLE_CMD="rc-update add"
  SERVICE_STATUS_CMD="rc-service status"
elif command -v systemctl >/dev/null 2>&1; then
  # Debian/Ubuntu with systemd
  SERVICE_CMD="systemctl"
  SERVICE_ENABLE_CMD="systemctl enable"
  SERVICE_STATUS_CMD="systemctl status"
else
  echo "Error: No supported service manager found (rc-service or systemctl)" >&2
  exit 1
fi

# Enable mosquitto service
if [ "$SERVICE_CMD" = "rc-service" ]; then
  rc-update add mosquitto default >&2
elif [ "$SERVICE_CMD" = "systemctl" ]; then
  systemctl enable mosquitto >&2
fi

# Start mosquitto service
$SERVICE_CMD mosquitto start >&2

# Verify that mosquitto is running
if ! $SERVICE_STATUS_CMD mosquitto >/dev/null 2>&1; then
  echo "Warning: Mosquitto service may not have started correctly" >&2
  exit 1
fi

exit 0
