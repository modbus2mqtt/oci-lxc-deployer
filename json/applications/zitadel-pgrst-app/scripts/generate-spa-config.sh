#!/bin/sh
# Generate config.json in the deployed SPA's web root.
#
# Runs inside the nginx LXC. All values come from template variables — the
# deployer knows the Zitadel issuer (from 150-conf-setup-oidc-client output),
# the client id (same), the postgrest URL (derived from subdomain), and the
# subdomain itself. An optional uploaded app.json is merged on top for
# app-specific runtime values.
#
# Template variables:
#   app_slug          - SPA directory under /usr/share/nginx/html/
#   app_subdomain     - SPA's FQDN (used for postgrest.url = https://<sub>/api)
#   app_json_content  - Optional base64 app.json overlay
#   oidc_issuer_url   - From 150-conf-setup-oidc-client
#   oidc_client_id    - From 150-conf-setup-oidc-client

set -eu

APP_SLUG="{{ app_slug }}"
APP_SUBDOMAIN="{{ app_subdomain }}"
APP_JSON_B64="{{ app_json_content }}"
ISSUER_URL="{{ oidc_issuer_url }}"
CLIENT_ID="{{ oidc_client_id }}"

if [ -z "$APP_SLUG" ] || [ "$APP_SLUG" = "NOT_DEFINED" ]; then
  echo "ERROR: app_slug is required" >&2
  exit 1
fi

TARGET_DIR="/usr/share/nginx/html/$APP_SLUG"
if [ ! -d "$TARGET_DIR" ]; then
  echo "ERROR: $TARGET_DIR does not exist (run 240-deploy-spa-to-nginx first)" >&2
  exit 1
fi

TARGET="$TARGET_DIR/config.json"

# Build base config from known parameters.
cat > "$TARGET" <<EOF
{
  "postgrest": { "url": "https://${APP_SUBDOMAIN}/api" },
  "oidc": {
    "issuer": "${ISSUER_URL}",
    "clientId": "${CLIENT_ID}",
    "redirectPath": "/callback",
    "scope": "openid profile email urn:zitadel:iam:user:resourceowner urn:zitadel:iam:org:project:id:zitadel:aud"
  }
}
EOF

# Optional app.json overlay merge (deep merge: base * overlay).
case "$APP_JSON_B64" in
  ""|NOT_DEFINED) ;;
  *)
    if command -v jq >/dev/null 2>&1; then
      OVERLAY="/tmp/app-${APP_SLUG}.json"
      if printf '%s' "$APP_JSON_B64" | base64 -d > "$OVERLAY" 2>/dev/null; then
        if jq -e '.' "$OVERLAY" >/dev/null 2>&1; then
          jq -s '.[0] * .[1]' "$TARGET" "$OVERLAY" > "${TARGET}.merged" && mv "${TARGET}.merged" "$TARGET"
          echo "generate-spa-config: merged app.json overlay" >&2
        else
          echo "WARN: app_json_content is not valid JSON, ignoring overlay" >&2
        fi
        rm -f "$OVERLAY"
      else
        echo "WARN: failed to base64-decode app_json_content, ignoring overlay" >&2
      fi
    else
      echo "WARN: jq not available — app.json overlay skipped" >&2
    fi
    ;;
esac

chown 101:101 "$TARGET" 2>/dev/null || true
echo "generate-spa-config: wrote $(wc -c < "$TARGET") bytes to $TARGET" >&2
echo '[]'
