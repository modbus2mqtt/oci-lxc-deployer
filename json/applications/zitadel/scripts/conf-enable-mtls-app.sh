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

# Two CNs, one per DB *role* (pg_hba `cert` maps cert-CN -> role). These are
# the fixed role names from zitadel.yaml.tmpl (User.Username=zitadel,
# Admin.Username=postgres), NOT the container hostname (e.g. the livetest
# hostname is `zitadel-mtls-certonly`; the role is still `zitadel`):
#   User.SSL  -> role `zitadel`    -> /certs/mtls/zitadel/
#   Admin.SSL -> superuser `postgres` -> /certs/mtls/postgres/
# The deploy must issue these CNs: mtls_cns="zitadel\npostgres" (zitadel app
# default; scenarios also set it explicitly).
USER_CN="zitadel"
ADMIN_CN="postgres"
USER_PATH="/certs/mtls/${USER_CN}"
ADMIN_PATH="/certs/mtls/${ADMIN_CN}"

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
for CN in "$USER_CN" "$ADMIN_CN"; do
  MTLS_CN_DIR="$CERTS_DIR/mtls/$CN"
  if [ -d "$MTLS_CN_DIR" ]; then
    chmod 0755 "$CERTS_DIR/mtls" "$MTLS_CN_DIR" 2>/dev/null || true
    chmod 0644 "$MTLS_CN_DIR"/*.pem 2>/dev/null || true
    echo "mtls: relaxed perms on $MTLS_CN_DIR for non-root zitadel-api user" >&2
  fi
done

CONFIG_DIR=$(resolve_host_volume "$SAFE_HOST" "config" "$VM_ID")
if [ -f "$CONFIG_DIR/zitadel.yaml" ]; then
  if grep -q 'RootCert:' "$CONFIG_DIR/zitadel.yaml"; then
    echo "mtls: zitadel.yaml already carries client cert config — no-op" >&2
  else
    # Block-aware rewrite: the User: block's SSL Mode gets USER_PATH, the
    # Admin: block's gets ADMIN_PATH (the single global sed of old wrongly
    # applied one CN to both). Portable awk (mawk/gawk); writes back in place
    # so the file's owner/mode (1000:1001) are preserved.
    TMPY=$(mktemp)
    awk -v up="$USER_PATH" -v ap="$ADMIN_PATH" '
      /^[ ]*User:[ ]*$/  { ctx="user";  print; next }
      /^[ ]*Admin:[ ]*$/ { ctx="admin"; print; next }
      /^[ ]*Mode: (disable|require)[ ]*$/ {
        ind=$0; sub(/Mode:.*/, "", ind)
        p = (ctx=="admin") ? ap : up
        printf "%sMode: verify-ca\n", ind
        printf "%sCert: %s/cert.pem\n", ind, p
        printf "%sKey: %s/privkey.pem\n", ind, p
        # CA chain is global (one project CA, identical for every CN) and is
        # written to the certs-volume ROOT by addon-ssl, NOT per-CN under
        # mtls/<CN>/. Pointing RootCert at the shared /certs/chain.pem avoids
        # the "open /certs/mtls/<CN>/chain.pem: no such file" failure.
        printf "%sRootCert: /certs/chain.pem\n", ind
        next
      }
      { print }
    ' "$CONFIG_DIR/zitadel.yaml" > "$TMPY"
    cat "$TMPY" > "$CONFIG_DIR/zitadel.yaml"
    rm -f "$TMPY"
    echo "mtls: patched zitadel.yaml Database SSL -> verify-ca (User=$USER_PATH, Admin=$ADMIN_PATH)" >&2
  fi
else
  echo "Warning: $CONFIG_DIR/zitadel.yaml not found — mTLS DB config not patched" >&2
fi

echo "[{\"id\":\"mtls_app_enabled\",\"value\":\"true\"},{\"id\":\"compose_file\",\"value\":\"$COMPOSE_MTLS_B64\"}]"
