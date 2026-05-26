#!/bin/bash
# Create the runner-wake-svc Zitadel Machine User and grant it the `wake`
# role on the gptwol project. Outputs the client_id/client_secret so the
# operator can copy them into the GitHub fork's Secrets:
#
#   WAKE_CLIENT_ID, WAKE_CLIENT_SECRET, ZITADEL_ISSUER_URL
#
# The Machine User performs an OAuth2 client_credentials grant to obtain
# JWTs targeting the gptwol-api audience. oauth2-proxy in front of gptwol
# validates those JWTs against Zitadel's JWKS.
#
# Prerequisites:
#   - Zitadel deployed (Step 10)
#   - gptwol deployed with addon-oauth2-proxy (gptwol-api project + API
#     application exist in Zitadel)
#   - gptwol's addon-oidc has created the `gptwol` project with the
#     `wake` role
#
# Usage:
#   ./production/setup-runner-wake-auth.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_lib.sh"

PVE_HOST="${PVE_HOST:-pve1.cluster}"

# Acquire Zitadel Management API Bearer (PAT from /bootstrap/admin-client.pat
# pre-hardening, falls back to OIDC JWT from deployer-cli machine user once
# hardening has removed the PAT file).
init_admin_pat "$PVE_HOST"
init_oidc_jwt  "$PVE_HOST"

# Build Zitadel API base URL. Prefer external (https://auth.ohnewarum.de) so
# the call works from the developer's laptop too, fall back to internal
# zitadel:8080 when run from the PVE host with admin PAT.
if [ -n "${OIDC_ISSUER_URL:-}" ]; then
  ZITADEL_API_BASE="${OIDC_ISSUER_URL%/}"
elif [ -n "${ZITADEL_ADMIN_PAT:-}" ]; then
  ZITADEL_API_BASE="http://zitadel:8080"
else
  echo "ERROR: Neither ZITADEL_ADMIN_PAT nor OIDC credentials available." >&2
  echo "  Run Step 10 (deploy zitadel) first." >&2
  exit 1
fi

# Helper: call Zitadel Management API. Prefers JWT, falls back to PAT.
zitadel_api() {
  local method="$1" path="$2" body="${3:-}"
  local hdr
  if [ -n "${OCI_DEPLOYER_TOKEN:-}" ]; then
    hdr="Authorization: Bearer ${OCI_DEPLOYER_TOKEN}"
  else
    hdr="Authorization: Bearer ${ZITADEL_ADMIN_PAT}"
  fi
  if [ -n "$body" ]; then
    curl -skL -X "$method" -H "$hdr" -H "Content-Type: application/json" \
      -d "$body" "${ZITADEL_API_BASE}${path}" 2>/dev/null
  else
    curl -skL -X "$method" -H "$hdr" -H "Content-Type: application/json" \
      "${ZITADEL_API_BASE}${path}" 2>/dev/null
  fi
}

echo "=== Setup runner-wake-svc Machine User in Zitadel ==="
echo "  Zitadel API: ${ZITADEL_API_BASE}"
echo ""

# --- 1. Find gptwol project (created by gptwol's addon-oidc on first deploy) ---
echo "Searching for 'gptwol' project (source of wake role)..."
PROJECT_RESPONSE=$(zitadel_api POST "/management/v1/projects/_search" \
  '{"queries":[{"nameQuery":{"name":"gptwol","method":"TEXT_QUERY_METHOD_EQUALS"}}]}')
PROJECT_ID=$(echo "$PROJECT_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: 'gptwol' project not found in Zitadel." >&2
  echo "  Deploy gptwol with addon-oidc first (production/setup-production.sh --step <gptwol-step>)." >&2
  exit 1
fi
echo "  Found gptwol project (ID ${PROJECT_ID})"

# --- 2. Find gptwol-api project (created by addon-oauth2-proxy) ---
echo "Searching for 'gptwol-api' project (the audience)..."
API_PROJECT_RESPONSE=$(zitadel_api POST "/management/v1/projects/_search" \
  '{"queries":[{"nameQuery":{"name":"gptwol-api","method":"TEXT_QUERY_METHOD_EQUALS"}}]}')
API_PROJECT_ID=$(echo "$API_PROJECT_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$API_PROJECT_ID" ]; then
  echo "ERROR: 'gptwol-api' project not found in Zitadel." >&2
  echo "  Deploy gptwol with addon-oauth2-proxy first." >&2
  exit 1
fi
echo "  Found gptwol-api project (ID ${API_PROJECT_ID})"

# --- 2b. Find wolproxy-api project (created by addon-oauth2-proxy on wolproxy deploy) ---
# Optional: wolproxy may not be deployed yet on first run. Treat absence
# as a warning, not an error — gptwol-only setup remains valid.
echo "Searching for 'wolproxy-api' project (second audience, optional)..."
WOLPROXY_API_RESPONSE=$(zitadel_api POST "/management/v1/projects/_search" \
  '{"queries":[{"nameQuery":{"name":"wolproxy-api","method":"TEXT_QUERY_METHOD_EQUALS"}}]}')
WOLPROXY_API_PROJECT_ID=$(echo "$WOLPROXY_API_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$WOLPROXY_API_PROJECT_ID" ]; then
  echo "  WARN: 'wolproxy-api' project not found — skipping (deploy wolproxy first if needed)."
else
  echo "  Found wolproxy-api project (ID ${WOLPROXY_API_PROJECT_ID})"
fi

# --- 3. Find or create runner-wake-svc Machine User ---
SVC_USERNAME="runner-wake-svc"
echo "Searching for Machine User '${SVC_USERNAME}'..."
SVC_RESPONSE=$(zitadel_api POST "/management/v1/users/_search" \
  "{\"queries\":[{\"userNameQuery\":{\"userName\":\"${SVC_USERNAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")
SVC_USER_ID=$(echo "$SVC_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$SVC_USER_ID" ]; then
  echo "Creating Machine User '${SVC_USERNAME}'..."
  CREATE_RESPONSE=$(zitadel_api POST "/v2/users/machine" \
    "{\"userName\":\"${SVC_USERNAME}\",\"name\":\"GitHub Actions Wake-on-LAN Caller\",\"accessTokenType\":\"ACCESS_TOKEN_TYPE_JWT\"}")
  SVC_USER_ID=$(echo "$CREATE_RESPONSE" | sed -n 's/.*"userId":"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$SVC_USER_ID" ]; then
    echo "ERROR: Failed to create Machine User. Response:" >&2
    echo "  ${CREATE_RESPONSE}" >&2
    exit 1
  fi
  echo "  Created Machine User (ID ${SVC_USER_ID})"
else
  echo "  Found existing Machine User (ID ${SVC_USER_ID})"
fi

# --- 4. Generate client credentials (regenerates on every run — operator
#        must paste fresh ones into GitHub Secrets after each invocation) ---
echo "Generating client credentials..."
CRED_RESPONSE=$(zitadel_api PUT "/v2/users/${SVC_USER_ID}/secret" "{}")
WAKE_CLIENT_ID=$(echo "$CRED_RESPONSE" | sed -n 's/.*"clientId":"\([^"]*\)".*/\1/p' | head -1)
WAKE_CLIENT_SECRET=$(echo "$CRED_RESPONSE" | sed -n 's/.*"clientSecret":"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$WAKE_CLIENT_ID" ] || [ -z "$WAKE_CLIENT_SECRET" ]; then
  echo "ERROR: Failed to generate client credentials. Response:" >&2
  echo "  ${CRED_RESPONSE}" >&2
  exit 1
fi

# --- 5. Grant `wake` role on gptwol project to the Machine User ---
# Idempotent: existing grants return HTTP 409 ALREADY_EXISTS and we ignore.
echo "Granting 'wake' role on gptwol project to ${SVC_USERNAME}..."
GRANT_RESPONSE=$(zitadel_api POST "/management/v1/users/${SVC_USER_ID}/grants" \
  "{\"projectId\":\"${PROJECT_ID}\",\"roleKeys\":[\"wake\"]}")
case "$GRANT_RESPONSE" in
  *'"userGrantId"'*) echo "  Role granted" ;;
  *'ALREADY_EXISTS'*|*'already exists'*) echo "  Role already granted (idempotent)" ;;
  *)
    echo "  WARN: Grant response unexpected:"
    echo "    ${GRANT_RESPONSE}"
    ;;
esac

echo ""
echo "=== runner-wake-svc setup complete ==="
echo ""
echo "Copy the following into the GitHub repo's Secrets"
echo "(Settings → Secrets and variables → Actions → New repository secret):"
echo ""
echo "  WAKE_CLIENT_ID      = ${WAKE_CLIENT_ID}"
echo "  WAKE_CLIENT_SECRET  = ${WAKE_CLIENT_SECRET}"
echo "  ZITADEL_ISSUER_URL  = ${ZITADEL_API_BASE}"
echo "  WAKE_AUDIENCE_PROJECT_ID = ${API_PROJECT_ID}                # gptwol-api"
if [ -n "$WOLPROXY_API_PROJECT_ID" ]; then
  echo "  WOLPROXY_AUDIENCE_PROJECT_ID = ${WOLPROXY_API_PROJECT_ID}  # wolproxy-api"
fi
echo ""
echo "Workflow usage (token endpoint + /api/wake call):"
echo ""
cat <<WORKFLOW
  - name: Wake ubuntupve via gptwol
    run: |
      JWT=\$(curl -fsS -X POST '${ZITADEL_API_BASE}/oauth/v2/token' \\
        -u "\${{ secrets.WAKE_CLIENT_ID }}:\${{ secrets.WAKE_CLIENT_SECRET }}" \\
        -d "grant_type=client_credentials" \\
        -d "scope=openid urn:zitadel:iam:org:project:id:${API_PROJECT_ID}:aud urn:zitadel:iam:org:projects:roles" \\
        | jq -r .access_token)
      echo "::add-mask::\$JWT"
      curl -fsS -X POST -H "Authorization: Bearer \$JWT" \\
        https://gptwol.ohnewarum.de/api/wake/ubuntupve
WORKFLOW
echo ""
