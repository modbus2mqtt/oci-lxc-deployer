#!/bin/sh

# Compute static IPs from prefixes and emit parameter overrides as JSON lines
# Inputs (templated):
#   {{ ip4_prefix }} (string)
#   {{ ip4_cidr }} (string)
#   {{ ip6_prefix }} (string)
#   {{ ip6_cidr }} (string)
#   {{ vm_id }} (string)
# Output:
# - If both prefixes set: a single JSON array with all entries
#   [ {"id":"use_static_ip","value":true}, {"id":"static_ip","value":"<ipv4/cidr>"}, {"id":"static_ip6","value":"<ipv6/cidr>"} ]
# - If one prefix set: individual JSON objects on separate lines (backward compatible)

has4=false
has6=false
ip4_val=""
ip6_val=""

# IPv4 from prefix
if [ -n "{{ ip4_prefix }}" ]; then
  if [ -z "{{ vm_id }}" ]; then
    echo "Missing vm_id for IPv4 prefix" >&2
    exit 2
  fi
  if [ -z "{{ ip4_cidr }}" ]; then
    echo "ip4_cidr must be set when ip4_prefix is used" >&2
    exit 2
  fi
  ip4_val="{{ ip4_prefix }}.{{ vm_id }}/{{ ip4_cidr }}"
  has4=true
fi

# IPv6 from prefix
if [ -n "{{ ip6_prefix }}" ]; then
  if [ -z "{{ vm_id }}" ]; then
    echo "Missing vm_id for IPv6 prefix" >&2
    exit 2
  fi
  if [ -z "{{ ip6_cidr }}" ]; then
    echo "ip6_cidr must be set when ip6_prefix is used" >&2
    exit 2
  fi
  ip6_val="{{ ip6_prefix }}:{{ vm_id }}/{{ ip6_cidr }}"
  has6=true
fi

if [ "$has4" = true ] && [ "$has6" = true ]; then
  echo '[{"id":"use_static_ip","value":true},{"id":"static_ip","value":"'"$ip4_val"'"},{"id":"static_ip6","value":"'"$ip6_val"'"}]'
elif [ "$has4" = true ]; then
  echo '{ "id": "use_static_ip", "value": true }'
  echo '{ "id": "static_ip", "value": "'"$ip4_val"'" }'
elif [ "$has6" = true ]; then
  echo '{ "id": "use_static_ip", "value": true }'
  echo '{ "id": "static_ip6", "value": "'"$ip6_val"'" }'
fi

exit 0
