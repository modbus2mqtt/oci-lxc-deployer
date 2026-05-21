#!/bin/sh
# Run the bootstrap.sh from the uploaded tgz to seed Zitadel demo orgs/users.
#
# Only executed when seed_demo_data=true. Acquires a Zitadel admin token via
# the deployer machine-credentials (DEPLOYER_OIDC_MACHINE_*), patches the
# upstream bootstrap.sh in-place to honour $ZITADEL_PAT, then invokes it with
# the required env block.
#
# IMPORTANT: The upstream bootstrap.sh today calls PUT /v2/features/instance
# which mutates GLOBAL Zitadel config. Until the upstream is patched (see
# Open Question 8), this template runs only against test/dev Zitadel
# instances. Production deployments leave seed_demo_data unset.
#
# Template variables — see template's parameters block.

set -eu

APP_SLUG="{{ app_slug }}"
APP_SUBDOMAIN="{{ app_subdomain }}"
TGZ_B64="{{ app_tgz_content }}"
SEED="{{ seed_demo_data }}"
ZITADEL_HOST="{{ ZITADEL_HOST }}"
ZITADEL_PROTO="{{ ZITADEL_PROTO }}"
ZITADEL_PORT="{{ ZITADEL_PORT }}"
POSTGRES_HOST="{{ POSTGRES_HOST }}"
POSTGRES_PASSWORD="{{ POSTGRES_PASSWORD }}"
MACHINE_CLIENT_ID="{{ DEPLOYER_OIDC_MACHINE_CLIENT_ID }}"
MACHINE_CLIENT_SECRET="{{ DEPLOYER_OIDC_MACHINE_CLIENT_SECRET }}"
DEPLOYER_OIDC_ISSUER_URL="{{ DEPLOYER_OIDC_ISSUER_URL }}"

case "$SEED" in true|1|yes) ;; *)
  echo "seed-demo-data: seed_demo_data=$SEED — skipping" >&2
  echo '[]'; exit 0
  ;;
esac

if [ -z "$TGZ_B64" ] || [ "$TGZ_B64" = "NOT_DEFINED" ]; then
  echo "ERROR: app_tgz_content is required" >&2; exit 1
fi

case "$ZITADEL_PROTO" in ""|NOT_DEFINED) ZITADEL_PROTO="https" ;; esac
case "$ZITADEL_PORT" in ""|NOT_DEFINED) ZITADEL_PORT="1443" ;; esac
ZITADEL_API="${ZITADEL_PROTO}://${ZITADEL_HOST}:${ZITADEL_PORT}"

# Stage tgz on VE host.
STAGE="/var/tmp/zpa-${APP_SLUG}-bootstrap"
rm -rf "$STAGE"; mkdir -p "$STAGE"
echo "seed-demo-data: extracting bootstrap/ to $STAGE" >&2
printf '%s' "$TGZ_B64" | base64 -d | tar -xzf - -C "$STAGE" bootstrap || {
  echo "ERROR: failed to extract bootstrap/ from tgz" >&2; exit 1
}
BOOTSTRAP_DIR="$STAGE/bootstrap"
BOOTSTRAP_SH="$BOOTSTRAP_DIR/bootstrap.sh"
[ -f "$BOOTSTRAP_SH" ] || { echo "ERROR: $BOOTSTRAP_SH not found" >&2; exit 1; }

# Acquire Zitadel admin token via client_credentials.
if [ -z "$MACHINE_CLIENT_ID" ] || [ "$MACHINE_CLIENT_ID" = "NOT_DEFINED" ]; then
  echo "ERROR: DEPLOYER_OIDC_MACHINE_CLIENT_ID missing — is zitadel deployed with setup_test_project=true?" >&2
  exit 1
fi
ISSUER="${DEPLOYER_OIDC_ISSUER_URL:-$ZITADEL_API}"
echo "seed-demo-data: requesting token at ${ISSUER}/oauth/v2/token" >&2
TOKEN_RESP=$(curl -sk -X POST "${ISSUER}/oauth/v2/token" \
  -u "${MACHINE_CLIENT_ID}:${MACHINE_CLIENT_SECRET}" \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode "scope=openid urn:zitadel:iam:org:project:id:zitadel:aud") || {
  echo "ERROR: token endpoint unreachable" >&2; exit 1
}
PAT=$(printf '%s' "$TOKEN_RESP" | sed -nE 's/.*"access_token":"([^"]+)".*/\1/p')
if [ -z "$PAT" ]; then
  echo "ERROR: no access_token in response: $TOKEN_RESP" >&2; exit 1
fi
export ZITADEL_PAT="$PAT"

# Patch bootstrap.sh in place to honour $ZITADEL_PAT env var instead of
# /bootstrap/admin-client.pat. Idempotent.
if grep -q '/bootstrap/admin-client.pat' "$BOOTSTRAP_SH"; then
  sed -i.bak 's|cat /bootstrap/admin-client\.pat|printf %s "$ZITADEL_PAT"|g' "$BOOTSTRAP_SH"
  echo "seed-demo-data: patched bootstrap.sh to read ZITADEL_PAT env" >&2
fi

# Required env for bootstrap.sh.
export ZITADEL_API
export ZITADEL_ISSUER="$ISSUER"
export LOGIN_ORIGIN="https://${APP_SUBDOMAIN}"
export POSTGREST_PORT=3000
export PGHOST="${POSTGRES_HOST}"
export PGUSER="postgres"
export PGPASSWORD="${POSTGRES_PASSWORD}"
export PGDATABASE="${APP_SLUG}"
export SHARED="$STAGE/shared"
mkdir -p "$SHARED"

# Make sure the host has the tooling bootstrap.sh expects (curl, jq, psql).
# PVE host is Debian — apt usually has them. We don't install silently to
# avoid surprises; warn loudly if missing.
for cmd in curl jq psql; do
  command -v "$cmd" >/dev/null 2>&1 || echo "WARN: $cmd not on PATH — bootstrap.sh may fail" >&2
done

echo "seed-demo-data: invoking bootstrap.sh" >&2
sh "$BOOTSTRAP_SH"
echo "seed-demo-data: bootstrap.sh complete" >&2

# Cleanup staging (token-bearing files).
rm -rf "$STAGE"

echo '[]'
