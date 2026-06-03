#!/bin/sh
# Back up the previous container's LXC config under the NEW CT number before a
# reconfigure/replace modifies or destroys the old container. Safety net for
# out-of-band `pct`-config edits that the deploy-params baseline cannot restore.
# Paired with host-check-conf-diff.sh (check phase), which diffs this backup
# against the finalized new .conf.
#
# Template variables:
#   previous_vm_id - the existing container being reconfigured/replaced
#   vm_id          - the new container number (backup is keyed by this)
#
# stdout: JSON only (the backup path). All logs go to stderr. Never use 2>&1.

PREVIOUS_VM_ID="{{ previous_vm_id }}"
VM_ID="{{ vm_id }}"

if [ -z "$PREVIOUS_VM_ID" ] || [ "$PREVIOUS_VM_ID" = "NOT_DEFINED" ]; then
  echo "No previous_vm_id — nothing to back up" >&2
  printf '{ "id": "conf_backup_path", "value": "" }'
  exit 0
fi

SRC="/etc/pve/lxc/${PREVIOUS_VM_ID}.conf"
BACKUP_DIR="/var/lib/proxvex/conf-backups/${VM_ID}"
DEST="${BACKUP_DIR}/previous-${PREVIOUS_VM_ID}.conf"

if [ ! -f "$SRC" ]; then
  echo "Source config $SRC not found — skipping backup" >&2
  printf '{ "id": "conf_backup_path", "value": "" }'
  exit 0
fi

mkdir -p "$BACKUP_DIR" >&2
if cp "$SRC" "$DEST" >&2; then
  echo "Backed up $SRC -> $DEST" >&2
  printf '{ "id": "conf_backup_path", "value": "%s" }' "$DEST"
else
  echo "WARNING: failed to back up $SRC -> $DEST" >&2
  printf '{ "id": "conf_backup_path", "value": "" }'
fi

exit 0
