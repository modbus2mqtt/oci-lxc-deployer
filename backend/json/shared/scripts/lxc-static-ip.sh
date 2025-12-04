#!/bin/sh

# Edit LXC network settings for a container
# Parameters:
#   {{ use_static_ip }} (boolean)
#   {{ static_ip }} (string)
#   {{ static_ip6 }} (string)
#   {{ static_gw }} (string)
#   {{ static_gw6 }} (string)
#   {{ vm_id }} (string)
#   {{ hostname }} (string)
#   {{ bridge }} (string)
ipv4_ok=true

 # Initialize IP variables (already computed or provided)
static_ip="{{ static_ip }}"
static_ip6="{{ static_ip6 }}"

if [ "{{ use_static_ip }}" != "true" ]; then
  echo "Static IP configuration not requested, skipping." >&2
  exit 0
fi

if [ -z "{{ vm_id }}" ]; then
  echo "No VMID provided!" >&2
  exit 2
fi

if [ -z "{{ hostname }}" ]; then
  echo "No hostname provided!" >&2
  exit 2
fi


ipv6_ok=true

if [ -n "$static_ip" ] && [ -n "{{ static_gw }}" ]; then
  ipv4_ok=true
else
  if [ -n "$static_ip" ] || [ -n "{{ static_gw }}" ]; then
    echo "Both static_ip and static_gw must be set for IPv4!" >&2
    exit 2
  fi
  ipv4_ok=false
fi

if [ -n "$static_ip6" ] && [ -n "{{ static_gw6 }}" ]; then
  ipv6_ok=true
else
  if [ -n "$static_ip6" ] || [ -n "{{ static_gw6 }}" ]; then
    echo "Both static_ip6 and static_gw6 must be set for IPv6!" >&2
    exit 2
  fi
  ipv6_ok=false
fi

if [ "$ipv4_ok" = false ] && [ "$ipv6_ok" = false ]; then
  echo "No valid static IP configuration provided!" >&2
  exit 2
fi

NET_OPTS="name=eth0,bridge={{ bridge }}"
if [ "$ipv4_ok" = true ]; then
  NET_OPTS="$NET_OPTS,ip=$static_ip,gw={{ static_gw }}"
fi
if [ "$ipv6_ok" = true ]; then
  NET_OPTS="$NET_OPTS,ip6=$static_ip6,gw6={{ static_gw6 }}"
fi
pct set {{ vm_id }} --net0 "$NET_OPTS" >&2
RC=$?
if [ $RC -ne 0 ]; then
  echo "Failed to set network configuration!" >&2
  exit $RC
fi

echo "Network configuration updated for VM {{ vm_id }}." >&2
exit 0
