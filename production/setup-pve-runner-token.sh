#!/bin/bash
# Create the PVE API role + user + token + ACL that the gh-runner LXC
# uses for snapshot/rollback operations, and inject the resulting
# credentials directly into the gh-runner LXC's lxc.environment so the
# runner-Prozess sees them on next start.
#
# Idempotent: re-running upgrades the role's privilege set, refreshes
# the ACL, and re-uses the existing token if present. Pass --rotate to
# invalidate the old token, create a new one, and re-inject.
#
# Reads role definitions from production/pve-roles.json (managed via
# pveum role list --output-format json export format). Sources the
# shared library json/shared/scripts/library/pve-acl-common.sh over
# SSH so the same primitives are used everywhere.
#
# Usage:
#   ./production/setup-pve-runner-token.sh <pve-host> [--test-target-vmid <vmid>] [--rotate] [--no-restart]
#
# Behavior:
#   - Always: ensure role, user, ACL on /vms/<test-target-vmid>.
#   - Token: created on first run, re-used otherwise; --rotate forces fresh.
#   - LXC env: when a fresh token was created (or --rotate), writes
#     PVE_API_TOKEN_ID/SECRET/HOST/CA_B64 lines into
#     /etc/pve/lxc/<gh-runner-vmid>.conf and `pct restart`s the LXC.
#     --no-restart skips the restart (env applies on next manual start).
#
# Defaults:
#   --test-target-vmid 9999    constant VMID for the snapshot-roundtrip test
#                              stub VM; the ACL is scoped to /vms/<vmid> only.

set -e

PVE_HOST="${1:?usage: $0 <pve-host> [--test-target-vmid <vmid>] [--rotate] [--no-restart]}"
shift || true

TEST_TARGET_VMID="9999"
ROTATE=0
NO_RESTART=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --test-target-vmid) TEST_TARGET_VMID="$2"; shift 2 ;;
        --rotate)           ROTATE=1; shift ;;
        --no-restart)       NO_RESTART=1; shift ;;
        --help|-h)          sed -n '2,/^set -e/p' "$0" | sed 's/^# \?//'; exit 0 ;;
        *) echo "[ERROR] unknown arg: $1" >&2; exit 1 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_FILE="$REPO_ROOT/json/shared/scripts/library/pve-acl-common.sh"
ROLES_FILE="$REPO_ROOT/production/pve-roles.json"

[ -f "$LIB_FILE" ]   || { echo "[ERROR] missing $LIB_FILE" >&2; exit 1; }
[ -f "$ROLES_FILE" ] || { echo "[ERROR] missing $ROLES_FILE" >&2; exit 1; }

SSH_OPTS="-o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10"

# Single SSH session: pveum ops + (optional) lxc.environment injection + pct restart.
# stdout from the remote is captured here; stderr (logs) streams through.
SECRET=$(
    ssh $SSH_OPTS "root@${PVE_HOST}" \
        TEST_TARGET_VMID="$TEST_TARGET_VMID" \
        ROTATE="$ROTATE" \
        NO_RESTART="$NO_RESTART" \
        ROLES_JSON="$(cat "$ROLES_FILE")" \
        ACL_LIB="$(cat "$LIB_FILE")" \
        bash -s <<'REMOTE'
set -e
eval "$ACL_LIB"

# 1. Apply every role from production/pve-roles.json idempotently.
echo "$ROLES_JSON" | python3 -c '
import json, sys
for r in json.load(sys.stdin):
    print(f"{r[\"roleid\"]} {r[\"privs\"]}")
' | while read -r role privs; do
    pve_acl_role_ensure "$role" "$privs"
done

# 2. User + token (privsep=0).
USER_ID="proxvex-runner@pam"
TOKEN_NAME="runner-token"
pve_acl_user_ensure "$USER_ID" "proxvex livetest runner token holder"
[ "$ROTATE" = "1" ] && pve_acl_token_drop "$USER_ID" "$TOKEN_NAME"
SECRET=$(pve_acl_token_ensure "$USER_ID" "$TOKEN_NAME" 0)

# 3. ACL on the test-target VMID only.
pve_acl_set "/vms/${TEST_TARGET_VMID}" "$USER_ID" "ProxvexLivetest" 0

# 4. Inject env into gh-runner LXC iff a fresh secret was just created.
#    --rotate forces step 2 to drop+recreate, so SECRET is non-empty then.
if [ -n "$SECRET" ]; then
    GH_VMID=$(pct list 2>/dev/null | awk '$NF=="gh-runner"{print $1; exit}')
    if [ -z "$GH_VMID" ]; then
        echo "[WARN] no LXC with hostname 'gh-runner' on $(hostname) — skipping env injection." >&2
        echo "       Deploy github-runner.json first, then re-run with --rotate." >&2
    else
        CONF="/etc/pve/lxc/${GH_VMID}.conf"
        CA_B64=$(base64 -w0 </etc/pve/pve-root-ca.pem 2>/dev/null || true)
        if [ -z "$CA_B64" ]; then
            echo "[WARN] /etc/pve/pve-root-ca.pem unreadable — PVE_API_CA_B64 will be empty." >&2
        fi

        # Strip stale PVE_API_* lines, then append the four current ones.
        sed -i '/^lxc\.environment:[[:space:]]*PVE_API_/d' "$CONF"
        {
            echo "lxc.environment: PVE_API_TOKEN_ID=${USER_ID}!${TOKEN_NAME}"
            echo "lxc.environment: PVE_API_TOKEN_SECRET=${SECRET}"
            echo "lxc.environment: PVE_API_HOST=$(hostname -f)"
            echo "lxc.environment: PVE_API_CA_B64=${CA_B64}"
        } >> "$CONF"
        echo "[OK] injected PVE_API_* env into LXC ${GH_VMID} (${CONF})" >&2

        if [ "$NO_RESTART" = "1" ]; then
            echo "[INFO] --no-restart: env applies on next manual start of LXC ${GH_VMID}." >&2
        else
            echo "[INFO] restarting LXC ${GH_VMID} to activate env..." >&2
            pct restart "$GH_VMID" >&2 || {
                echo "[WARN] pct restart failed; activate manually with 'pct restart ${GH_VMID}'." >&2
            }
        fi
    fi
else
    echo "[INFO] token already existed; env in gh-runner LXC unchanged." >&2
    echo "       Re-run with --rotate to force a fresh secret + re-inject." >&2
fi

# Emit secret to stdout (empty if not freshly created).
printf '%s' "$SECRET"
REMOTE
)

# Operator-facing summary.
echo ""
echo "=== Summary ==="
echo "  PVE_HOST           : ${PVE_HOST}"
echo "  TEST_TARGET_VMID   : ${TEST_TARGET_VMID}"
if [ -n "$SECRET" ]; then
    echo "  Token              : fresh (auto-injected into gh-runner LXC)"
    echo ""
    echo "  PVE_API_TOKEN_ID   = proxvex-runner@pam!runner-token"
    echo "  PVE_API_TOKEN_SECRET = ${SECRET}"
    echo ""
    echo "  Stored verbatim in /etc/pve/lxc/<gh-runner-vmid>.conf"
    echo "  as lxc.environment: lines. No need to copy into production/github-runner.json."
else
    echo "  Token              : reused (no change to gh-runner LXC env)"
fi
