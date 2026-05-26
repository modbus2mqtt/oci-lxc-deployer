#!/bin/bash
# Enable Wake-on-LAN on a PVE host's primary network interface.
#
# UEFI/BIOS WoL alone is insufficient — Linux must park the NIC in
# WoL mode before poweroff, otherwise the magic packet is ignored.
# This script installs ethtool and a systemd unit that re-applies
# `ethtool -s <iface> wol g` at boot and again right before shutdown.
#
# Idempotent: re-running upgrades the unit and re-enables it. Detects
# the primary interface from the default-route automatically; can be
# overridden with --iface <name>.
#
# Usage:
#   ./production/setup-wol-on-host.sh <pve-host> [--iface eth0]
#
# After this:
#   - ethtool installed
#   - /etc/systemd/system/proxvex-wol.service enabled + started
#   - `ethtool <iface> | grep Wake-on` shows `g` (or `pg` if password set)

set -e

PVE_HOST="${1:?usage: $0 <pve-host> [--iface <iface>]}"
shift || true

IFACE_OVERRIDE=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --iface) IFACE_OVERRIDE="$2"; shift 2 ;;
        --help|-h) sed -n '2,/^set -e/p' "$0" | sed 's/^# \?//'; exit 0 ;;
        *) echo "[ERROR] unknown arg: $1" >&2; exit 1 ;;
    esac
done

SSH_OPTS="-o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10"

echo "[INFO] Setting up WoL on root@${PVE_HOST}..."

# Pass --iface override via env to the remote heredoc; empty means auto-detect.
ssh $SSH_OPTS "root@${PVE_HOST}" IFACE_OVERRIDE="$IFACE_OVERRIDE" bash -s <<'REMOTE'
set -e

# 1. Detect primary interface (default-route-bearing) unless overridden.
if [ -n "${IFACE_OVERRIDE}" ]; then
    IFACE="${IFACE_OVERRIDE}"
else
    IFACE=$(ip -j route show default 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d[0]['dev'])
except Exception:
    pass
" 2>/dev/null || ip route show default | awk '/^default/{print $5; exit}')
fi
[ -z "$IFACE" ] && { echo "[ERROR] could not detect primary interface" >&2; exit 1; }
echo "[OK] primary interface: ${IFACE}"

# 2. ethtool present?
if ! command -v ethtool >/dev/null 2>&1; then
    echo "[INFO] installing ethtool..."
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ethtool
fi

# 3. Probe current WoL state.
CURRENT=$(ethtool "${IFACE}" 2>/dev/null | sed -n 's/.*Wake-on: //p' | head -1)
SUPPORTED=$(ethtool "${IFACE}" 2>/dev/null | sed -n 's/.*Supports Wake-on: //p' | head -1)
echo "[INFO] ${IFACE} supports Wake-on: ${SUPPORTED:-<unknown>}"
echo "[INFO] ${IFACE} current Wake-on: ${CURRENT:-<unknown>}"

case "${SUPPORTED}" in
    *g*) ;;
    *)
        echo "[ERROR] ${IFACE} does not support 'g' (Magic Packet) wake mode." >&2
        echo "        Check UEFI/BIOS WoL settings and the NIC datasheet." >&2
        exit 1
        ;;
esac

# 4. Apply live (in case the unit is not yet running).
ethtool -s "${IFACE}" wol g
NEW=$(ethtool "${IFACE}" 2>/dev/null | sed -n 's/.*Wake-on: //p' | head -1)
echo "[OK] live setting after ethtool -s: ${NEW}"

# 5. Install systemd unit. ExecStart at boot, ExecStop at shutdown — covers
#    both NIC-reset on cold-boot and driver-unload right before poweroff.
cat >/etc/systemd/system/proxvex-wol.service <<EOF
[Unit]
Description=proxvex: enable Wake-on-LAN on ${IFACE}
After=network-online.target
Wants=network-online.target
DefaultDependencies=no
Before=shutdown.target reboot.target halt.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/ethtool -s ${IFACE} wol g
ExecStop=/usr/sbin/ethtool -s ${IFACE} wol g
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now proxvex-wol.service >/dev/null 2>&1 || systemctl enable proxvex-wol.service
systemctl status proxvex-wol.service --no-pager | head -5 || true

echo "[OK] proxvex-wol.service installed and enabled for ${IFACE}"
REMOTE

echo ""
echo "WoL setup on ${PVE_HOST} complete."
echo "Verify: ssh root@${PVE_HOST} 'ethtool \$(ip route show default | awk \"/default/{print \\\$5; exit}\") | grep Wake-on'"
echo "Expected: 'Wake-on: g'"
