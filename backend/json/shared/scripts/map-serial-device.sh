# Map serial device if provided
if [  "{{ usb }}" = "false" ]; then
  echo "No serial device specified, skipping mapping. {{ usb }}" >&2
  exit 0
fi
echo "Checking if VM {{ vm_id }} is running... {{ usb }}" >&2
VM_WAS_RUNNING=0
if pct status {{ vm_id }} | grep -q 'status: running'; then
  pct stop {{ vm_id }} >&2
  VM_WAS_RUNNING=1
fi

if [ -n "{{ serial_host }}" ]; then
  if [ -e "{{ serial_host }}" ]; then
    # Auto-select SERIAL_CONT based on SERIAL_HOST
    BASENAME=$(basename "{{ serial_host }}")
    if echo "{{ serial_host }}" | grep -q "/dev/serial/by-id/"; then
      SERIAL_CONT="/dev/ttyUSB0"
    else
      SERIAL_CONT="/dev/$BASENAME"
    fi
    echo "Mapping serial device {{ serial_host }} to container as $SERIAL_CONT..." >&2
    pct set {{ vm_id }} -mp0 {{ serial_host }},$SERIAL_CONT,mp=$SERIAL_CONT >&2
  else
    echo "Serial device {{ serial_host }} does not exist on the host!" >&2
  fi
fi

if [ "$VM_WAS_RUNNING" -eq 1 ]; then
  echo "Restarting VM {{ vm_id }}..." >&2
  pct start {{ vm_id }} >&2
fi
