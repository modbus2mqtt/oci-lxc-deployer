#!/bin/sh
# Compute static IPs from prefixes and emit parameter overrides
#
# This script computes static IP addresses by:
# 1. Deriving IPv4 address from prefix and VM ID
# 2. Deriving IPv6 address from prefix and VM ID
# 3. Emitting parameter overrides as JSON for use in subsequent templates
#
# Requires:
#   - vm_id: LXC container ID (from context)
#   - ip4_prefix: IPv4 network prefix (optional)
#   - ip4_cidr: IPv4 CIDR notation (optional)
#   - ip6_prefix: IPv6 network prefix (optional)
#   - ip6_cidr: IPv6 CIDR notation (optional)
#
# Output: JSON parameter overrides to stdout (errors to stderr)
# Note: Do NOT use exec >&2 here, as it redirects ALL stdout to stderr, including JSON output

# Output:
# - If both prefixes set: a single JSON array with all entries
#   [ {"id":"use_static_ip","value":true}, {"id":"static_ip","value":"<ipv4/cidr>"}, {"id":"static_ip6","value":"<ipv6/cidr>"} ]
# - If one prefix set: individual JSON objects on separate lines (backward compatible)

has4=false
has6=false
ip4_val=""
ip6_val=""

# Unresolved template variables are replaced with "NOT_DEFINED" - treat as empty
ip4_prefix="{{ ip4_prefix }}"
ip4_cidr="{{ ip4_cidr }}"
ip6_prefix="{{ ip6_prefix }}"
ip6_cidr="{{ ip6_cidr }}"
[ "$ip4_prefix" = "NOT_DEFINED" ] && ip4_prefix=""
[ "$ip4_cidr" = "NOT_DEFINED" ] && ip4_cidr=""
[ "$ip6_prefix" = "NOT_DEFINED" ] && ip6_prefix=""
[ "$ip6_cidr" = "NOT_DEFINED" ] && ip6_cidr=""

# IPv4 from prefix
if [ -n "$ip4_prefix" ]; then
  if [ -z "{{ vm_id }}" ]; then
    echo "Missing vm_id for IPv4 prefix" >&2
    exit 2
  fi
  if [ -z "$ip4_cidr" ]; then
    echo "ip4_cidr must be set when ip4_prefix is used" >&2
    exit 2
  fi
  ip4_val="${ip4_prefix}.{{ vm_id }}/${ip4_cidr}"
  has4=true
fi

# IPv6 from prefix
if [ -n "$ip6_prefix" ]; then
  if [ -z "{{ vm_id }}" ]; then
    echo "Missing vm_id for IPv6 prefix" >&2
    exit 2
  fi
  if [ -z "$ip6_cidr" ]; then
    echo "ip6_cidr must be set when ip6_prefix is used" >&2
    exit 2
  fi
  ip6_val="${ip6_prefix}:{{ vm_id }}/${ip6_cidr}"
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
