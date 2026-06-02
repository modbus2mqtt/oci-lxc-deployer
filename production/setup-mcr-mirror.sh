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
# Site customization: install the MCR Registry Mirror application as a local
# override on the production deployer Hub, then deploy it to the configured
# host (defaults to ubuntupve via host_for_app in setup-production.sh).
#
# Why local override (vs. shipping the app under json/applications/):
#   The application's properties (vm_id, static_ip, gateway, etc.) are
#   site-specific. Putting the file in the deployer's /config volume keeps it
#   out of the repository and out of the OCI image — same pattern as
#   setup-ghcr-mirror.sh.
#
# Why the mirror exists at all:
#   Test/CI hosts run a nested Proxmox VM whose dnsmasq DNS-redirects
#   mcr.microsoft.com to a local mirror so that large mcr images (notably
#   mcr.microsoft.com/playwright, ~2 GB) can be pulled without the double-NAT
#   transfer timing out. The nested VM pulls over the LAN while this mirror
#   fetches from mcr over the host's direct internet. Production apps do NOT
#   use the mirror (no DNS forward in production).
#
# A separate application (mcr-registry-mirror, extends docker-registry-mirror)
# is required: deploy.sh enforces one container per application, so reusing the
# base docker-registry-mirror would collide with docker-mirror-test.
#
# Usage: ./production/setup-mcr-mirror.sh
#   DEPLOYER_HOSTNAME (env)  hostname of the deployer LXC (default: proxvex)
#   MCR_MIRROR_HOST   (env)  PVE host to deploy on (default: ubuntupve)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Shared helpers: auth_curl + init_admin_pat. /api/reload is OIDC-protected
# after Step 11, so the call needs the Zitadel admin PAT as Bearer.
. "$SCRIPT_DIR/_lib.sh"
init_admin_pat
init_oidc_jwt

DEPLOYER_HOSTNAME="${DEPLOYER_HOSTNAME:-proxvex}"
MCR_MIRROR_HOST="${MCR_MIRROR_HOST:-ubuntupve}"

# Locate the running deployer container and its /config mountpoint.
VMID=$(pct list 2>/dev/null \
  | awk -v h="$DEPLOYER_HOSTNAME" 'NR>1 && $2=="running" && $NF==h {print $1; exit}')

if [ -z "$VMID" ]; then
  echo "ERROR: No running container with hostname '$DEPLOYER_HOSTNAME' found"
  echo "  Set DEPLOYER_HOSTNAME to match the deployer container hostname."
  exit 1
fi

CONFIG_VOLID=$(pct config "$VMID" 2>/dev/null \
  | awk '/^mp[0-9]+:.*[ ,]mp=\/config([, ]|$)/ {
      sub(/^mp[0-9]+:[[:space:]]+/, "");
      split($0, a, ",");
      print a[1];
      exit
    }')

if [ -z "$CONFIG_VOLID" ]; then
  echo "ERROR: VMID $VMID has no mountpoint at /config"
  exit 1
fi

CONFIG_VOL=$(pvesm path "$CONFIG_VOLID" 2>/dev/null || true)
if [ -z "$CONFIG_VOL" ] || [ ! -d "$CONFIG_VOL" ]; then
  echo "ERROR: Could not resolve config volume path (volid=$CONFIG_VOLID, path=$CONFIG_VOL)"
  exit 1
fi

echo "Using config volume of running VMID $VMID: $CONFIG_VOL"

# 1. Write the application override into /config/applications/.
APP_DIR="${CONFIG_VOL}/applications/mcr-registry-mirror"
mkdir -p "$APP_DIR"

# mcr.microsoft.com is an anonymous registry — no REGISTRY_PROXY_USERNAME/
# PASSWORD (unlike the Docker Hub / ghcr mirrors). 50G data volume because
# the playwright image alone is ~2 GB.
cat > "${APP_DIR}/application.json" <<'EOF'
{
  "name": "MCR Registry Mirror",
  "description": "Pull-through cache for mcr.microsoft.com. Site infrastructure for test/CI hosts (e.g. mcr.microsoft.com/playwright); production apps do not consume it.",
  "extends": "docker-registry-mirror",
  "icon": "icon.svg",
  "properties": [
    { "id": "hostname", "default": "mcr-mirror" },
    { "id": "vm_id", "default": "604" },
    { "id": "static_ip", "default": "192.168.4.52/24" },
    { "id": "gateway", "default": "192.168.4.1" },
    { "id": "bridge", "default": "vmbr0" },
    { "id": "nameserver", "default": "192.168.4.1" },
    { "id": "memory", "default": "1024" },
    { "id": "rootfs_storage", "default": "local-zfs" },
    { "id": "disk_size", "default": "5" },
    { "id": "volumes", "default": "data=/var/lib/registry,size=50G" },
    { "id": "envs", "default": "REGISTRY_HTTP_ADDR=:443\nREGISTRY_HTTP_TLS_CERTIFICATE=/etc/ssl/addon/fullchain.pem\nREGISTRY_HTTP_TLS_KEY=/etc/ssl/addon/privkey.pem\nREGISTRY_PROXY_REMOTEURL=https://mcr.microsoft.com\nOTEL_SDK_DISABLED=true\nREGISTRY_LOG_LEVEL=info\nREGISTRY_LOG_FIELDS_ENVIRONMENT=production" },
    { "id": "ssl_additional_san", "value": "DNS:mcr.microsoft.com" }
  ],
  "tags": ["infrastructure"]
}
EOF

# Same chown pattern as setup-ghcr-mirror.sh — match the existing /config
# ownership so the deployer process inside the container can read the file.
chown -R --reference="${CONFIG_VOL}" "${CONFIG_VOL}"

echo "App definition written to ${APP_DIR}/application.json"

# 2. Reload the deployer so it picks up the new application.
if auth_curl -sk --connect-timeout 5 -X POST "https://${DEPLOYER_HOSTNAME}:3443/api/reload" -o /dev/null; then
  echo "Deployer reloaded via HTTPS"
elif auth_curl -sf --connect-timeout 5 -X POST "http://${DEPLOYER_HOSTNAME}:3080/api/reload" -o /dev/null; then
  echo "Deployer reloaded via HTTP"
else
  echo "WARN: deployer reload call failed — continuing; deploy.sh will fail clearly if reload was needed"
fi

# 3. Deploy via the standard production deploy.sh wrapper.
"$SCRIPT_DIR/deploy.sh" --host "$MCR_MIRROR_HOST" mcr-registry-mirror

echo ""
echo "MCR Registry Mirror deployed:"
echo "  Host:     $MCR_MIRROR_HOST"
echo "  Hostname: mcr-mirror"
echo "  Address:  192.168.4.52 (per app default; override in /config/stacks if needed)"
echo "  Test:     curl --resolve mcr.microsoft.com:443:192.168.4.52 https://mcr.microsoft.com/v2/"
