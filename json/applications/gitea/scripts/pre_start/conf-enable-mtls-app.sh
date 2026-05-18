#!/bin/sh
# Enable client-side mTLS for the Gitea (oci-image) PostgreSQL connection.
#
# Overrides the shared no-op script. Runs on the PVE host during pre_start,
# after 161-conf-generate-mtls-certs (client cert written to the `mtls/<CN>/`
# subdir of gitea's `certs` volume — mounted at /etc/ssl/addon by addon-ssl).
#
# Gitea is oci-image based, so DB config is injected as lxc.environment lines
# in /etc/pve/lxc/<vmid>.conf, exactly like gitea's conf-enable-ssl-app.sh.
# Gitea's Go lib/pq driver honours libpq PG* env vars and is version-robust.
#
# Client-side only: PostgreSQL-side client-cert verification is configured by
# deploying the `postgres` dependency with addon-ssl + pg_client_cert=true,
# and the cert-only `gitea` login role is created by template 187 (db_role).
#
# resolve_host_volume is auto-injected for execute_on:ve scripts (ve-global.sh).
# pve_sanitize_name is NOT auto-injected (pve-common.sh, not declared as a
# template library), so the SAFE_HOST slug is computed inline like zitadel's
# conf-enable-mtls-app.sh.
set -eu

HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"
CERTS_B64="{{ mtls_client_certs_b64 }}"
CONF_FILE="/etc/pve/lxc/${VM_ID}.conf"

# Skip when mTLS is not active (no signed client cert bundle present).
if [ -z "$CERTS_B64" ] || [ "$CERTS_B64" = "NOT_DEFINED" ]; then
  echo "mtls: no client cert bundle — skipping gitea mTLS app config" >&2
  echo '[{"id":"mtls_app_enabled","value":"false"}]'
  exit 0
fi

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: LXC config not found: $CONF_FILE" >&2
  echo '[{"id":"mtls_app_enabled","value":"false"}]'
  exit 1
fi

# The client-cert CN must equal the PostgreSQL login role gitea connects as
# (pg_hba `cert` maps CN -> role). That role is always `gitea` (created by the
# operator / livetest overlay; GITEA__database__USER=gitea below), independent
# of the container hostname (which is e.g. `gitea-mtls` in livetest). So the
# CN — and thus the addon-mtls cert subdir `mtls/<CN>/` — is the fixed role
# name, NOT $HOSTNAME. The deploy must issue this CN: mtls_cns must contain
# `gitea` (livetest sets it explicitly; production hostname is `gitea` so the
# {{ hostname }} default also yields it).
CN="gitea"
MTLS_PATH="/etc/ssl/addon/mtls/${CN}"

# --- 1. Append the libpq / Gitea DB env (idempotent) ---
if grep -q '^lxc\.environment: GITEA__database__SSL_MODE=' "$CONF_FILE"; then
  echo "mtls: gitea LXC config already carries mTLS DB env — no-op" >&2
else
  {
    echo "lxc.environment: GITEA__database__SSL_MODE=verify-ca"
    echo "lxc.environment: GITEA__database__USER=gitea"
    echo "lxc.environment: PGSSLCERT=${MTLS_PATH}/cert.pem"
    echo "lxc.environment: PGSSLKEY=${MTLS_PATH}/privkey.pem"
    echo "lxc.environment: PGSSLROOTCERT=${MTLS_PATH}/chain.pem"
  } >> "$CONF_FILE"
  echo "mtls: appended verify-ca + client cert env to $CONF_FILE ($MTLS_PATH)" >&2
fi

# --- 2. Cert perms for the non-root git user (UID 1000) ---
# 161-conf-generate-mtls-certs already chowns the mtls/ subtree to gitea's
# effective UID/GID, so the 0600 privkey is owned by the git user and readable
# by lib/pq. Defensively make the dirs traversable and the public cert/chain
# group/other-readable; keep the private key 0600 (lib/pq is fine with an
# owner-only key it owns).
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
CERTS_DIR=$(resolve_host_volume "$SAFE_HOST" "certs" "$VM_ID")
MTLS_CN_DIR="$CERTS_DIR/mtls/$CN"
if [ -d "$MTLS_CN_DIR" ]; then
  chmod 0755 "$CERTS_DIR/mtls" "$MTLS_CN_DIR" 2>/dev/null || true
  chmod 0644 "$MTLS_CN_DIR/cert.pem" "$MTLS_CN_DIR/chain.pem" 2>/dev/null || true
  chmod 0600 "$MTLS_CN_DIR/privkey.pem" 2>/dev/null || true
  echo "mtls: set perms on $MTLS_CN_DIR (privkey 0600, cert/chain 0644)" >&2
fi

echo '[{"id":"mtls_app_enabled","value":"true"}]'
