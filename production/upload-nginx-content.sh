#!/bin/bash
# >>> proxvex-cwd-guard (auto-generated) — repo-root cwd + absolute $0, any caller cwd
case "$0" in
  /*) _pvx_self="$0" ;;
  *)  _pvx_self="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")" || { echo "FATAL cwd-guard: cannot resolve $0" >&2; exit 2; } ;;
esac
_pvx_rr="$(cd "$(dirname "$_pvx_self")/.." 2>/dev/null && pwd)" || { echo "FATAL cwd-guard: cannot resolve repo root from $0" >&2; exit 2; }
if [ -f "$_pvx_rr/package.json" ] && [ -d "$_pvx_rr/e2e" ] && [ -d "$_pvx_rr/production" ]; then
  if [ "$0" != "$_pvx_self" ]; then cd "$_pvx_rr" && exec "$_pvx_self" "$@"; fi
  cd "$_pvx_rr" || echo "WARN cwd-guard: cannot cd to '$_pvx_rr'; continuing in $(pwd)" >&2
fi
unset _pvx_self _pvx_rr
# <<< proxvex-cwd-guard
# Upload production/ folder to PVE host and re-run setup-nginx.sh.
#
# Usage (from dev machine):
#   ./production/upload-nginx-content.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PVE_HOST="${PVE_HOST:-pve1.cluster}"
SSH_OPTS="-o StrictHostKeyChecking=no"
REMOTE_DIR="/root/production"

echo "=== Uploading production/ to ${PVE_HOST}:${REMOTE_DIR} ==="
rsync -az --delete -e "ssh ${SSH_OPTS}" "$SCRIPT_DIR/" "root@${PVE_HOST}:${REMOTE_DIR}/"
echo "  Done."

echo ""
echo "=== Running setup-nginx.sh on ${PVE_HOST} ==="
ssh ${SSH_OPTS} "root@${PVE_HOST}" "bash ${REMOTE_DIR}/setup-nginx.sh"
