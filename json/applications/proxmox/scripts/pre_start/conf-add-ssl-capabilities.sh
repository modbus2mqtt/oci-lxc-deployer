#!/bin/sh
# Proxmox override: No LXC capabilities needed for PVE host (target IS the host,
# not an LXC). Emits the `ssl_capabilities_set` output that the shared template
# (170-conf-add-ssl-capabilities.json) declares — "false" because nothing was
# changed at the LXC layer. Without this, output validation rejects the run.

echo "Proxmox host: no LXC capabilities needed" >&2
printf '[{"id": "ssl_capabilities_set", "value": "false"}]\n'
