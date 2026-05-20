#!/bin/sh
# Fetch the OIDC JWKS document and write it to the postgrest jwks volume.
#
# PostgREST cannot poll JWKS from URLs itself (only file/literal sources).
# We fetch once at install/reconfigure; Zitadel key rotation is rare and
# manual, so the next reconfigure picks up new keys without crons or
# sidecars.
#
# Template variables:
#   pgrst_jwks_url - JWKS endpoint (skip when empty)
#   hostname       - Container hostname (default: postgrest)
#   vm_id          - PostgREST container VMID
#
# Library functions are prepended automatically:
# - pve_sanitize_name, resolve_host_volume (pve-common.sh / ve-global.sh)

JWKS_URL="{{ pgrst_jwks_url }}"
HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"

case "$JWKS_URL" in ""|NOT_DEFINED)
  echo "fetch-jwks: pgrst_jwks_url not set — skipping (PostgREST will run without JWT validation)" >&2
  echo '[]'
  exit 0
  ;;
esac

if [ -z "$VM_ID" ] || [ "$VM_ID" = "NOT_DEFINED" ]; then
  echo "ERROR: vm_id required to resolve jwks volume" >&2
  exit 1
fi

SAFE_HOST=$(pve_sanitize_name "$HOSTNAME")
JWKS_DIR=$(resolve_host_volume "$SAFE_HOST" "jwks" "$VM_ID") || {
  echo "ERROR: could not resolve jwks volume for $SAFE_HOST (vm $VM_ID)" >&2
  exit 1
}
mkdir -p "$JWKS_DIR"

TARGET="$JWKS_DIR/jwks.json"
TMP="$JWKS_DIR/.jwks.json.tmp.$$"
trap 'rm -f "$TMP"' EXIT

echo "fetch-jwks: GET $JWKS_URL -> $TARGET" >&2
if ! curl -fsSLk -o "$TMP" "$JWKS_URL"; then
  echo "ERROR: failed to fetch JWKS from $JWKS_URL" >&2
  exit 1
fi

# Minimal sanity check: must be valid JSON with a `keys` array.
if ! grep -q '"keys"' "$TMP"; then
  echo "ERROR: response from $JWKS_URL does not look like a JWKS (no \"keys\")" >&2
  cat "$TMP" >&2
  exit 1
fi

mv "$TMP" "$TARGET"
chmod 0644 "$TARGET"
echo "fetch-jwks: wrote $(wc -c < "$TARGET") bytes to $TARGET" >&2

echo '[]'
