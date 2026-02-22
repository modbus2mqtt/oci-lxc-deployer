#!/bin/sh
# Start and enable lighttpd service (runs inside the container)
set -eu

# Enable lighttpd service
rc-update add lighttpd default >&2

# Start lighttpd service
rc-service lighttpd start >&2

# Verify that lighttpd is running
if ! rc-service lighttpd status >/dev/null 2>&1; then
  echo "Warning: lighttpd service may not have started correctly" >&2
  exit 1
fi

exit 0



