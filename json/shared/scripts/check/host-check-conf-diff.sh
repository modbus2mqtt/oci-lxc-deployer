#!/bin/sh
# Diff the backed-up previous container .conf against the finalized new .conf
# and emit the differences to stderr, so they are captured in the diagnostic
# bundle and the user can review what a reconfigure changed (including changes
# the deploy-params baseline did not / could not restore).
#
# Reads the BACKUP written by host-backup-previous-container-conf.sh (not the
# live old .conf, which may already be replaced/destroyed by this point).
#
# Informational only: always exits 0 (PASS). stdout is the check JSON result;
# the diff goes to stderr. Never use 2>&1.
#
# Template variables:
#   previous_vm_id - the container that was reconfigured/replaced
#   vm_id          - the new container number

PREVIOUS_VM_ID="{{ previous_vm_id }}"
VM_ID="{{ vm_id }}"

if [ -z "$PREVIOUS_VM_ID" ] || [ "$PREVIOUS_VM_ID" = "NOT_DEFINED" ]; then
  echo "CHECK: conf_diff SKIPPED (no previous_vm_id)" >&2
  printf '[{"id":"check_conf_diff","value":"skipped (no previous_vm_id)"}]'
  exit 0
fi

OLD="/var/lib/proxvex/conf-backups/${VM_ID}/previous-${PREVIOUS_VM_ID}.conf"
NEW="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$OLD" ]; then
  echo "CHECK: conf_diff — no backup at $OLD" >&2
  printf '[{"id":"check_conf_diff","value":"no backup"}]'
  exit 0
fi
if [ ! -f "$NEW" ]; then
  echo "CHECK: conf_diff — new config $NEW not found" >&2
  printf '[{"id":"check_conf_diff","value":"no new config"}]'
  exit 0
fi

echo "=== conf diff (old ${PREVIOUS_VM_ID} -> new ${VM_ID}) ===" >&2
DIFF=$(diff -u "$OLD" "$NEW")
if [ -z "$DIFF" ]; then
  echo "(no differences)" >&2
  echo "=== end conf diff ===" >&2
  printf '[{"id":"check_conf_diff","value":"no differences"}]'
else
  echo "$DIFF" >&2
  echo "=== end conf diff ===" >&2
  printf '[{"id":"check_conf_diff","value":"differences logged to stderr"}]'
fi

exit 0
