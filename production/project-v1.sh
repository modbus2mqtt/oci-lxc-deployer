#!/bin/sh
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
# Set project-specific defaults (Video 1: basic setup).
# Sets vm_id_start and package mirrors. No OIDC issuer URL yet —
# addon-oidc defaults to internal Zitadel URL (zitadel:1443).
#
# Usage: ./production/project-v1.sh

set -e

DEPLOYER_HOSTNAME="${DEPLOYER_HOSTNAME:-proxvex}"

# Auto-detect config volume path on PVE host
_safe_host=$(echo "$DEPLOYER_HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
CONFIG_VOL=$(find /rpool/data/ -maxdepth 1 -name "*-${_safe_host}-config" -type d 2>/dev/null | head -1)

if [ -z "$CONFIG_VOL" ] || [ ! -d "$CONFIG_VOL" ]; then
  echo "ERROR: Cannot find config volume for hostname '$DEPLOYER_HOSTNAME'"
  echo "  Expected pattern: /rpool/data/*-${_safe_host}-config"
  echo "  Set DEPLOYER_HOSTNAME to match the deployer container hostname."
  exit 1
fi

SHARED_VOL="${CONFIG_VOL}/shared/templates"

echo "=== Setting project defaults (v1) ==="

mkdir -p "${SHARED_VOL}/create_ct"
cat > "${SHARED_VOL}/create_ct/050-set-project-parameters.json" << 'EOF'
{
  "name": "Set Project Parameters",
  "description": "Project-specific defaults for ohnewarum.de (v1, no OIDC issuer)",
  "commands": [
    {
      "properties": [
        { "id": "vm_id_start", "default": "500" },
        { "id": "alpine_mirror", "default": "https://mirror1.hs-esslingen.de/Mirrors/alpine/" },
        { "id": "debian_mirror", "default": "http://mirror.23m.com/debian/" }
      ]
    }
  ]
}
EOF

# Ownership vom config-Verzeichnis übernehmen (hat korrekte Container-UID)
chown -R --reference="${CONFIG_VOL}" "${CONFIG_VOL}"

echo "  Template written to ${SHARED_VOL}/create_ct/050-set-project-parameters.json"
echo "=== Project defaults (v1) configured ==="
