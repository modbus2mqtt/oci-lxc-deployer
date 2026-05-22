#!/bin/sh
# Ensure the PVE host's sshd has the proxvex drop-in config with relaxed
# connection-startup limits. Idempotent: rewrites the file every time, so
# upgrades from older proxvex versions (which shipped without
# MaxStartups) self-heal on the next install / upgrade / reconfigure.
#
# Why this exists:
#   The self-upgrade-via-clone orchestrator (backend/src/services/
#   self-upgrade-orchestrator.mts) runs the Hub-CT and a Clone-CT in
#   parallel, both executing `execute_on: ve` templates against the
#   same sshd. Each template opens a fresh SSH connection through the
#   in-CT openssh client (no master mux). sshd's default MaxStartups
#   10:30:100 starts probabilistic rejection at 10 unauthenticated
#   concurrent connections and rejects them pre-auth with the banner
#   "Not allowed at this time" — failing the clone's reconfigure
#   pipeline mid-step. Raising the threshold to 100:30:200 (+ per-source
#   50) covers the worst-case parallel burst (~30 SSHs in flight during
#   the create_ct + pre_start + replace_ct overlap).
#
# Side effect: also covers install-proxvex.sh + ssh.mts's
# getInstallSshServerCommand which write the same drop-in — this script
# is the single source of truth that runs in every proxvex life-cycle
# hook (installation / upgrade / reconfigure), so existing deployments
# self-heal on next operation without any manual intervention.

set -eu

CONF=/etc/ssh/sshd_config.d/proxvex.conf
TMP="${CONF}.new"

cat > "$TMP" <<'SSHCONF'
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
ChallengeResponseAuthentication no
UsePAM no
AuthorizedKeysFile .ssh/authorized_keys .ssh/authenticated_keys
AllowUsers root
# Raised so the PVE host can absorb the parallel SSH bursts a clone-driven
# self-upgrade produces (Hub-CT + Clone-CT both running execute_on:ve
# templates in lockstep). Default 10:30:100 rejected the second concurrent
# batch with "Not allowed at this time" pre-auth banner.
MaxStartups 100:30:200
PerSourceMaxStartups 50
# sshd 10+ anti-bruteforce penalties block legit repeated SSH from the
# same source after a few unauthenticated connections. Trips during
# clone-driven self-upgrade where each template opens its own ssh call.
PerSourcePenalties no
AcceptEnv LANG LC_*
SSHCONF

# Compare to skip the reload when nothing changed.
if [ -f "$CONF" ] && cmp -s "$CONF" "$TMP"; then
  rm -f "$TMP"
  echo "sshd config already up to date" >&2
  printf '[{"id":"sshd_config_updated","value":"false"}]'
  exit 0
fi

mv "$TMP" "$CONF"
echo "Updated $CONF — reloading sshd" >&2
systemctl reload ssh >&2 2>/dev/null \
  || systemctl reload sshd >&2 2>/dev/null \
  || systemctl restart ssh >&2 2>/dev/null \
  || systemctl restart sshd >&2 2>/dev/null \
  || echo "Warning: could not reload sshd — config will apply on next sshd start" >&2

printf '[{"id":"sshd_config_updated","value":"true"}]'
