#!/bin/bash
# pct-cleanup - Destroy a range of LXC containers
#
# Usage:
#   pct-cleanup <from> <to>
#   pct-cleanup 100 112
#   pct-cleanup 105 105   # single container

FROM=${1:?Usage: pct-cleanup <from> <to>}
TO=${2:?Usage: pct-cleanup <from> <to>}

for vmid in $(seq "$FROM" "$TO"); do
    if pct status "$vmid" &>/dev/null; then
        pct stop "$vmid" 2>/dev/null
        pct destroy "$vmid" --purge && echo "Destroyed $vmid" || echo "Failed to destroy $vmid"
    else
        echo "Skipped $vmid (not found)"
    fi
done
