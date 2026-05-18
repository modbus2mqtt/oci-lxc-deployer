#!/bin/sh
# Enable client-side mTLS for the Zitadel docker-compose application.
#
# Overrides the shared no-op script. Runs on the PVE host during pre_start,
# after 161-conf-generate-mtls-certs (client cert written to the `mtls/`
# subdir of the managed `certs` volume) and after 159-conf-enable-ssl-app.
#
# 1. Bind-mounts the managed `certs` volume into the zitadel-api service
#    (the same /certs mount the SSL hook already binds into traefik).
# 2. Patches Database.postgres.User.SSL and .Admin.SSL in the on-volume
#    zitadel.yaml so Zitadel presents its client cert to PostgreSQL
#    (Mode: verify-ca + Cert/Key/RootCert under /certs/mtls/<hostname>/).
#
# Client-side only: PostgreSQL-side client-cert verification is out of scope.
# Requires addon-ssl (it creates/owns the `certs` volume and the /certs
# docker mount, and verify-ca needs the postgres server cert from the same
# root CA).
set -eu

HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"
COMPOSE_B64="{{ compose_file }}"
CERTS_B64="{{ mtls_client_certs_b64 }}"

# Skip when mTLS is not active (no signed client cert bundle present).
if [ -z "$CERTS_B64" ] || [ "$CERTS_B64" = "NOT_DEFINED" ]; then
  echo "mtls: no client cert bundle — skipping zitadel mTLS app config" >&2
  echo '[{"id":"mtls_app_enabled","value":"false"}]'
  exit 0
fi

SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
MTLS_PATH="/certs/mtls/${HOSTNAME}"

# --- 1. Add the /certs bind mount to the zitadel-api service (idempotent) ---
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT
printf '%s' "$COMPOSE_B64" | base64 -d > "$TMPFILE"

# Idempotency must be zitadel-api-specific: the SSL hook already adds
# `- /certs:/certs:ro` to the *traefik* service, so a whole-file grep would
# wrongly conclude zitadel-api is done. Check the line right after
# zitadel-api's unique `/config:/zitadel/config:ro` mount instead.
if grep -A1 -- '- /config:/zitadel/config:ro' "$TMPFILE" | grep -q -- '- /certs:/certs:ro'; then
  echo "mtls: zitadel-api already has /certs mount, skipping compose patch" >&2
else
  # /config:/zitadel/config:ro is unique to the zitadel-api service; insert
  # the certs mount right after it so it lands in that service's volumes:.
  sed -i "/- \/config:\/zitadel\/config:ro/a\\
      - /certs:/certs:ro" "$TMPFILE"
  echo "mtls: added /certs:/certs:ro to zitadel-api service" >&2
fi
COMPOSE_MTLS_B64=$(base64 < "$TMPFILE" | tr -d '\n')

# --- 2. Patch Database SSL blocks in the on-volume zitadel.yaml ---
# zitadel.yaml is written pre-start by conf-write-zitadel-yaml (step 155) to
# the `config` managed volume. 159-conf-enable-ssl-app may have already set
# Mode: require — upgrade either disable or require to verify-ca and add the
# client cert paths under both User.SSL and Admin.SSL.
# --- 2a. Relax mtls cert perms for the non-root zitadel-api docker user ---
# conf-generate-mtls-certs.sh writes the subtree owned by the container-root
# id map with privkey.pem 0600 / dirs 0700. The zitadel-api service runs as a
# non-root user and must read cert+key+chain for the PostgreSQL client auth,
# so relax the mtls/<cn>/ path the same way zitadel's SSL hook relaxes the
# certs-volume root for the non-root Traefik user.
CERTS_DIR=$(resolve_host_volume "$SAFE_HOST" "certs" "$VM_ID")
MTLS_CN_DIR="$CERTS_DIR/mtls/$HOSTNAME"
if [ -d "$MTLS_CN_DIR" ]; then
  chmod 0755 "$CERTS_DIR/mtls" "$MTLS_CN_DIR" 2>/dev/null || true
  chmod 0644 "$MTLS_CN_DIR"/*.pem 2>/dev/null || true
  echo "mtls: relaxed perms on $MTLS_CN_DIR for non-root zitadel-api user" >&2
fi

CONFIG_DIR=$(resolve_host_volume "$SAFE_HOST" "config" "$VM_ID")
if [ -f "$CONFIG_DIR/zitadel.yaml" ]; then
  if grep -q 'RootCert:' "$CONFIG_DIR/zitadel.yaml"; then
    echo "mtls: zitadel.yaml already carries client cert config — no-op" >&2
  else
    sed -i -E "s#^([[:space:]]*)Mode: (disable|require)#\1Mode: verify-ca\n\1Cert: ${MTLS_PATH}/cert.pem\n\1Key: ${MTLS_PATH}/privkey.pem\n\1RootCert: ${MTLS_PATH}/chain.pem#g" "$CONFIG_DIR/zitadel.yaml"
    echo "mtls: patched zitadel.yaml Database SSL -> verify-ca + client cert ($MTLS_PATH)" >&2
  fi
else
  echo "Warning: $CONFIG_DIR/zitadel.yaml not found — mTLS DB config not patched" >&2
fi

echo "[{\"id\":\"mtls_app_enabled\",\"value\":\"true\"},{\"id\":\"compose_file\",\"value\":\"$COMPOSE_MTLS_B64\"}]"
