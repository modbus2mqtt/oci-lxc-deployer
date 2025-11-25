#!/bin/sh


# Auto-select the best storage for LXC rootfs (most free space, supports rootdir) and set ROOTFS variable

# Auto-select the best storage for LXC rootfs (most free space, supports rootdir) and set ROOTFS variable
ROOTFS_RESULT=$(pvesm status | awk 'NR>1 {print $1, $6}' | while read stor free; do
  if pvesm list "$stor" --content rootdir 2>/dev/null | grep -q .; then
    if pvesm status --storage "$stor" | grep -q zfs; then
      echo "$free $stor size"
    else
      echo "$free $stor normal"
    fi
  fi
done | sort -nr | head -n1)

set -- $ROOTFS_RESULT
stor=$2
type=$3

if [ -z "$stor" ]; then
  echo "No suitable storage found for LXC rootfs!" >&2
  exit 1
fi

ROOTFS="$stor:$(({{ disk_size }} * 1024))"
echo "Rootfs: $ROOTFS" >&2

# Auto-select VMID if not set
if [ -z "{{ vm_id }}" ]; then
  # Find the next free VMID (highest existing + 1)
  VMID=$(pvesh get /cluster/nextid)
else
  VMID="{{ vm_id }}"
fi

 # Create the container
pct create "$VMID" "{{ template_path }}" \
  --rootfs "$ROOTFS" \
  --hostname "{{ hostname }}" \
  --memory "{{ memory }}" \
  --net0 name=eth0,bridge="{{ bridge }}",ip=dhcp \
  --ostype "{{ ostype }}" \
  --unprivileged 1 >&2
RC=$? 
if [ $RC -ne 0 ]; then
  echo "Failed to create LXC container!" >&2
  exit $RC
fi
echo "LXC container $VMID ({{ hostname }}) created." >&2
echo '{ "name": "vm_id", "value": "'$VMID'" }'