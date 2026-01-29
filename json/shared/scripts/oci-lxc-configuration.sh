#!/bin/sh

VMID="{{ vm_id }}"
INITIAL_COMMAND="{{ initial_command }}"

CONFIG_FILE="/etc/pve/lxc/${VMID}.conf"
LOG_DIR="/var/log/lxc"
LOG_FILE="${LOG_DIR}/container-${VMID}.log"

if [ -z "$VMID" ]; then
    echo "Error: vm_id is not set" >&2
    exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Configuration file $CONFIG_FILE not found" >&2
    exit 1
fi


# Add lxc.init_cmd if initial_command is provided
if [ -n "$INITIAL_COMMAND" ] &&  [ "$INITIAL_COMMAND" != "NOT_DEFINED" ] && [ -f "$CONFIG_FILE" ]; then
  # Append init_cmd to config
  echo "lxc.init_cmd: $INITIAL_COMMAND" >> "$CONFIG_FILE"
  echo "Set lxc.init_cmd: $INITIAL_COMMAND" >&2
fi

# Output valid JSON as per rules
echo '{}'
