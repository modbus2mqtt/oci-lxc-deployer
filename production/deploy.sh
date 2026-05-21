#!/bin/bash
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
# Deploy one or more applications to a PVE host via the proxvex deployer.
#
# Usage:
#   ./deploy.sh [--host <pve-host>] <app|file.json> [<app|file.json> ...]
#   ./deploy.sh <app>                          # uses default host
#   ./deploy.sh --host ubuntupve github-runner # explicit override
#
# Env:
#   PVE_HOST       default target PVE host (default: pve1.cluster)
#   DEPLOYER_HOST  default: proxvex
#
# The host is also passed to the proxvex CLI as `--ve <host>`, so the chosen
# PVE host must be registered in the deployer's SSH config (see
# setup-pve-host.sh).

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Shared helpers: auth_curl + init_admin_pat + init_oidc_jwt. After Step 11
# the deployer enforces OIDC on /api/* and rejects opaque tokens (e.g. PATs)
# with HTTP 401 / "Invalid Compact JWS". init_oidc_jwt reads the deployer-cli
# machine credentials from /bootstrap/deployer-oidc.json on the Zitadel LXC,
# performs an OIDC client_credentials grant, and exports the resulting JWT as
# OCI_DEPLOYER_TOKEN — picked up by both auth_curl and oci-lxc-cli.
. "$SCRIPT_DIR/_lib.sh"

PVE_HOST="${PVE_HOST:-pve1.cluster}"
DEPLOYER_HOST="${DEPLOYER_HOST:-proxvex}"

# Pull credentials so both ensure_stack's curl and the CLI invocation below
# carry valid auth post-OIDC. Both are no-ops if Zitadel/deployer-oidc.json
# isn't ready yet (pre-Zitadel-deploy phase).
init_admin_pat "$PVE_HOST"
init_oidc_jwt "$PVE_HOST"
# Optional: load operator-issued PAT for headless Zitadel-API auth in
# templates (conf-setup-oidc-client.sh & friends). When set, gets injected
# as a `ZITADEL_PAT` param into every params.json before the CLI call so
# the templates use it instead of the on-LXC /bootstrap/admin-client.pat.
init_deployer_pat

# augment_params_with_pat <input_file> → echoes path of params file to use.
# When OCI_DEPLOYER_PAT is set, writes a tempfile with the original
# params + a `{"name":"ZITADEL_PAT","value":"<pat>"}` entry appended
# (replacing any existing entry of the same name). Caller is responsible
# for removing the returned file if it differs from the input.
augment_params_with_pat() {
  local input="$1"
  if [ -z "${OCI_DEPLOYER_PAT:-}" ]; then
    echo "$input"
    return 0
  fi
  # Write the augmented file into the SAME directory as the input. The CLI
  # resolves `file:foo.conf` parameter values relative to the params.json
  # directory, so a /tmp tempfile would break upload references like
  # `file:mosquitto.conf` or `file:node-red-settings.js`
  # (resolved against /tmp instead of production/).
  local input_dir
  input_dir=$(cd "$(dirname "$input")" && pwd)
  local out="${input_dir}/.deploy-params.augmented.$$.json"
  python3 - "$input" "$OCI_DEPLOYER_PAT" > "$out" <<'EOF'
import json, sys
input_file, pat = sys.argv[1], sys.argv[2]
with open(input_file) as f:
    data = json.load(f)
params = [p for p in data.get("params", []) if p.get("name") != "ZITADEL_PAT"]
params.append({"name": "ZITADEL_PAT", "value": pat})
data["params"] = params
print(json.dumps(data))
EOF
  echo "$out"
}

# Optional per-call flags (any order, before the app/file args):
#   --host|--ve <host>   target PVE host
#   --replace            destroy an existing same-app container before install
REPLACE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host|--ve) PVE_HOST="$2"; shift 2 ;;
    --replace)   REPLACE=1; shift ;;
    *) break ;;
  esac
done

# Auto-detect: HTTPS (port 3443) or HTTP (port 3080)
if curl -sk --connect-timeout 3 "https://${DEPLOYER_HOST}:3443/api/applications" >/dev/null 2>&1; then
  SERVER="https://${DEPLOYER_HOST}:3443"
else
  SERVER="http://${DEPLOYER_HOST}:3080"
fi
echo "Using deployer at ${SERVER}"

# Detect execution mode: PVE host (use pct exec) or dev machine (use npx tsx)
DEPLOYER_VMID=""
if command -v pct >/dev/null 2>&1; then
  DEPLOYER_VMID=$(pct list 2>/dev/null | awk -v h="$DEPLOYER_HOST" '$3 == h {print $1}')
fi

# Run the CLI in --json mode, mirroring livetest's cli-executor.mts pattern:
#   - stdout = structured JSON lines (progress + a final {…,restartKey} line);
#     captured to a file AND rendered human-readably via a jq passthrough
#     (raw JSON fallback when jq is absent).
#   - stderr = raw script output; captured to a file (surfaced on failure).
# On a non-zero CLI exit, fetch the per-task debug bundle from
#   GET /api/ve/debug/:restartKey            (manifest: { files: [...] })
#   GET /api/ve/debug/:restartKey/<file>     (each file)
# into production/diagnostics/<label>-<UTC>/, alongside the captured
# stdout/stderr — the same endpoints test-result-writer.mts uses.
# Returns the CLI exit code; never aborts before diagnostics are written.
run_cli_capture() {
  local label="$1"; shift
  local ts out err rc dir
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  out=$(mktemp); err=$(mktemp)

  set +e
  if command -v jq >/dev/null 2>&1; then
    "$@" 2>"$err" | tee "$out" | jq -R --unbuffered -r '
      fromjson? // empty
      | select(type=="object" and (.command|type=="string"))
      | "[\((.index // 0)+1)] \(.command) " +
        (if ((.exitCode // 0) != 0) then "FAILED"
         elif (.finished == true) then "OK" else "..." end)'
    rc=${PIPESTATUS[0]}
  else
    echo "  (jq not found — raw JSON progress; install jq for readable output)" >&2
    "$@" 2>"$err" | tee "$out"
    rc=${PIPESTATUS[0]}
  fi
  # NB: stay under `set +e` through diagnostics so a non-zero grep/curl can't
  # abort before the bundle is written; errexit is restored just before return.

  local restart_key
  restart_key=$(grep -o '"restartKey":"[^"]*"' "$out" 2>/dev/null \
    | head -1 | sed 's/.*:"//; s/"$//')

  if [ "$rc" -ne 0 ]; then
    dir="$SCRIPT_DIR/diagnostics/${label}-${ts}"
    mkdir -p "$dir"
    cp "$out" "$dir/cli-stdout.jsonl" 2>/dev/null || true
    cp "$err" "$dir/cli-stderr.log" 2>/dev/null || true
    if [ -n "$restart_key" ]; then
      local manifest
      manifest=$(auth_curl -sk --max-time 30 \
        "$SERVER/api/ve/debug/${restart_key}" 2>/dev/null || true)
      local files
      files=$(printf '%s' "$manifest" | python3 -c \
        'import sys,json
try: print("\n".join(json.load(sys.stdin).get("files",[])))
except Exception: pass' 2>/dev/null || true)
      if [ -n "$files" ]; then
        local n=0
        printf '%s\n' "$files" | while IFS= read -r f; do
          [ -z "$f" ] && continue
          mkdir -p "$dir/$(dirname "$f")"
          auth_curl -sk --max-time 60 \
            "$SERVER/api/ve/debug/${restart_key}/${f}" -o "$dir/$f" \
            2>/dev/null || true
        done
        n=$(printf '%s\n' "$files" | grep -c .)
        echo "  Debug bundle: ${n} file(s) → $dir" >&2
      else
        echo "  Debug bundle empty/unavailable (debug_level off or expired) — captured cli-stdout/stderr in $dir" >&2
      fi
    else
      echo "  No restartKey in CLI output — captured cli-stdout/stderr in $dir" >&2
    fi
    echo "  Diagnostics: $dir" >&2
  fi

  # Always surface the completion banner (e.g. Zitadel admin login/password
  # from template 380). In --json mode these are structured outputs on
  # stdout; the jq passthrough only prints step status, and on success $out
  # is discarded — so without this the credentials would be lost. Scan the
  # captured stdout for the known completion output ids (schema-tolerant).
  local banner
  banner=$(python3 - "$out" <<'PY' 2>/dev/null || true
import sys, json
WANT = ("completion_header", "admin_loginname", "completion_details", "completion_url")
found = {}
def walk(o):
    if isinstance(o, dict):
        i, v = o.get("id"), o.get("value")
        if isinstance(i, str) and i in WANT and i not in found and v is not None:
            found[i] = v
        for x in o.values():
            walk(x)
    elif isinstance(o, list):
        for x in o:
            walk(x)
try:
    for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line or line[0] != "{":
            continue
        try:
            walk(json.loads(line))
        except Exception:
            pass
except Exception:
    pass
if found:
    bar = "=" * 64
    print(bar)
    print(found.get("completion_header", "Completion"))
    # completion_details already carries the Login+Password block; only fall
    # back to admin_loginname when details is absent (avoids a double Login).
    if "completion_details" in found:
        print(str(found["completion_details"]))
    elif "admin_loginname" in found:
        print("Login: " + str(found["admin_loginname"]))
    if "completion_url" in found:
        print("URL:   " + str(found["completion_url"]))
    print(bar)
PY
)
  [ -n "$banner" ] && printf '%s\n' "$banner" >&2

  rm -f "$out" "$err"
  set -e
  return "$rc"
}

# --- Duplicate-install guard ----------------------------------------------
# Production runs exactly one managed container per application. A silent
# second `install` (re-running a step without destroying first) is what
# produced the 502/503 duplicate-postgres and orphaned-zitadel failures.
# Before an install task, refuse if a managed container for the same
# application already exists on the target VE; --replace destroys it first.
# upgrade/reconfigure are exempt — they intentionally target the existing
# container (resolve_previous_vmid handles those).
_managed_vmids_for_app() {
  local app="$1" body
  body=$(auth_curl -sk --max-time 30 \
    "$SERVER/api/ve_${PVE_HOST}/installations" 2>/dev/null || true)
  [ -z "$body" ] && return 0
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq -r ".[]? | select(.application_id == \"$app\") | .vm_id" 2>/dev/null
  else
    printf '%s' "$body" | tr ',' '\n' | awk -v app="$app" '
      /"vm_id":/ { gsub(/[^0-9]/, ""); cur=$0 }
      /"application_id":/ { gsub(/"|application_id|:| /, ""); if ($0==app && cur!="") print cur; cur="" }'
  fi
}

guard_no_existing_install() {
  local params_file="$1" task app vmids v
  task=$(grep -oE '"task"[[:space:]]*:[[:space:]]*"[^"]+"' "$params_file" 2>/dev/null \
    | head -1 | sed -E 's/.*"task"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
  case "$task" in
    upgrade|reconfigure) return 0 ;;
  esac
  app=$(grep -oE '"application"[[:space:]]*:[[:space:]]*"[^"]+"' "$params_file" 2>/dev/null \
    | head -1 | sed -E 's/.*"application"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
  [ -z "$app" ] && return 0
  vmids=$(_managed_vmids_for_app "$app" | grep -E '^[0-9]+$' | sort -u || true)
  [ -z "$vmids" ] && return 0
  if [ "${REPLACE:-0}" -eq 1 ]; then
    echo "  --replace: destroying existing '$app' container(s) on ${PVE_HOST}: $(echo $vmids)" >&2
    for v in $vmids; do
      ssh -o StrictHostKeyChecking=no "root@${PVE_HOST}" \
        "pct unlock $v 2>/dev/null; pct stop $v 2>/dev/null; pct destroy $v --purge --force" >&2 \
        || { echo "ERROR: failed to destroy VM $v ($app) on ${PVE_HOST}" >&2; exit 1; }
    done
    return 0
  fi
  echo "" >&2
  echo "ERROR: install of '$app' aborted — a managed container already exists on" >&2
  echo "       ${PVE_HOST} (VMID: $(echo $vmids)). Production is exactly one" >&2
  echo "       container per application; a silent second install is what caused" >&2
  echo "       the duplicate-postgres / orphaned-zitadel failures." >&2
  echo "" >&2
  echo "  Choose one:" >&2
  echo "    - Replace it:      $0 --replace --host ${PVE_HOST} <app|file.json>" >&2
  echo "    - Update in place: set \"task\":\"upgrade\" in the params file" >&2
  echo "    - Or destroy VMID $(echo $vmids) manually, then re-run." >&2
  exit 1
}

if [ -n "$DEPLOYER_VMID" ]; then
  echo "Running on PVE host (deployer container: $DEPLOYER_VMID)"
  run_cli() {
    local params_file="$1"
    shift
    local with_pat
    with_pat=$(augment_params_with_pat "$params_file")
    local effective_params
    effective_params=$(augment_params_with_previous_vmid "$with_pat") || true
    local lbl _rc=0
    lbl=$(basename "${params_file%.json}")
    # Push JSON file into container and run CLI from inside.
    # Use HTTPS — after Step 6 (ACME) the HTTP listener on :3080 only
    # serves a 301 to :3443, and the CLI's HTTP client does not follow
    # redirects on POST, so plain http://localhost:3080 returns
    # "Not found" instead of the expected route handler.
    guard_no_existing_install "$params_file"
    pct push "$DEPLOYER_VMID" "$effective_params" /tmp/deploy-params.json
    run_cli_capture "$lbl" \
      pct exec "$DEPLOYER_VMID" -- oci-lxc-cli remote \
        --server https://localhost:3443 --ve "$PVE_HOST" \
        --insecure --json "$@" /tmp/deploy-params.json || _rc=$?
    pct exec "$DEPLOYER_VMID" -- rm -f /tmp/deploy-params.json || true
    [ "$effective_params" != "$with_pat" ] && rm -f "$effective_params"
    [ "$with_pat" != "$params_file" ] && rm -f "$with_pat"
    return "$_rc"
  }
else
  echo "Running on dev machine (using npx tsx)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  # --yes: auto-install tsx without the interactive "Ok to proceed?" prompt,
  # which would otherwise stall an unattended setup-production.sh --all run.
  CLI="npx --yes tsx $PROJECT_ROOT/cli/src/oci-lxc-cli.mts"

  # Load OIDC credentials if available (optional — without .env, CLI runs without auth)
  ENV_FILE="$SCRIPT_DIR/.env"
  if [ -f "$ENV_FILE" ]; then
    set -a; . "$ENV_FILE"; set +a
    echo "OIDC credentials loaded from $ENV_FILE"
  fi

  # Build OIDC flags if credentials are set
  OIDC_FLAGS=""
  if [ -n "$OIDC_CLI_CLIENT_ID" ]; then
    OIDC_FLAGS="--oidc-issuer $OIDC_ISSUER_URL --oidc-client-id $OIDC_CLI_CLIENT_ID --oidc-client-secret $OIDC_CLI_CLIENT_SECRET"
  fi

  run_cli() {
    local params_file="$1"
    shift
    local with_pat
    with_pat=$(augment_params_with_pat "$params_file")
    local effective_params
    effective_params=$(augment_params_with_previous_vmid "$with_pat") || true
    local lbl _rc=0
    lbl=$(basename "${params_file%.json}")
    # Exported (not command-prefixed) so the CLI child spawned inside
    # run_cli_capture reliably inherits it. Dev-mode only — insecure by design.
    guard_no_existing_install "$params_file"
    export NODE_TLS_REJECT_UNAUTHORIZED=0
    run_cli_capture "$lbl" $CLI remote \
      --server "$SERVER" --ve "$PVE_HOST" --insecure --json \
      $OIDC_FLAGS "$@" "$effective_params" || _rc=$?
    [ "$effective_params" != "$with_pat" ] && rm -f "$effective_params"
    [ "$with_pat" != "$params_file" ] && rm -f "$with_pat"
    return "$_rc"
  }
fi

ensure_stack() {
  echo "=== Ensuring production stacks exist ==="
  # Each stacktype has its own stack with ID: {type}_production.
  # auth_curl injects the Zitadel admin PAT as Bearer when set (post-OIDC).
  for TYPE in postgres oidc cloudflare; do
    STACK_ID="${TYPE}_production"
    if auth_curl -sk "$SERVER/api/stacks?stacktype=${TYPE}" 2>/dev/null | grep -q "\"${STACK_ID}\""; then
      echo "  Stack '${STACK_ID}' exists."
    else
      echo "  Creating stack '${STACK_ID}'..."
      auth_curl -sk -X POST "$SERVER/api/stacks" \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"production\",\"stacktype\":\"${TYPE}\",\"entries\":[]}" \
        -o /dev/null -w "HTTP %{http_code}\n" || true
    fi
  done
}

deploy_app() {
  local app="$1"
  local timeout="${2:-600}"
  local params="$SCRIPT_DIR/$app.json"

  echo "=== Deploying $app ==="
  if [ ! -f "$params" ]; then
    echo "ERROR: $params not found"; exit 1
  fi

  run_cli "$params" --timeout "$timeout"
}

# Resolve previous_vm_id for upgrade/reconfigure tasks by querying the
# deployer's installations API for managed containers with the given
# application_id. Errors out if zero or more-than-one are found — for
# multi-instance setups the operator must specify previous_vm_id manually
# in the params file. Echoes the VMID on stdout when exactly one is found.
resolve_previous_vmid() {
  local app="$1"
  local body
  body=$(auth_curl -sk --max-time 30 "$SERVER/api/ve_${PVE_HOST}/installations" 2>/dev/null)
  if [ -z "$body" ]; then
    echo "WARN: could not query installations API — cannot auto-detect previous_vm_id for $app" >&2
    return 1
  fi
  # Extract vm_ids where application_id matches. Use jq if available, else
  # fall back to a grep+awk pipeline that handles the same JSON shape.
  local matches
  if command -v jq >/dev/null 2>&1; then
    matches=$(echo "$body" | jq -r ".[] | select(.application_id == \"$app\") | .vm_id" 2>/dev/null)
  else
    matches=$(echo "$body" | tr ',' '\n' | awk -v app="$app" '
      /"vm_id":/ { gsub(/[^0-9]/, ""); cur_vmid=$0 }
      /"application_id":/ { gsub(/"|application_id|:| /, ""); if ($0 == app && cur_vmid != "") print cur_vmid; cur_vmid="" }
    ')
  fi
  local count
  count=$(echo "$matches" | grep -c .)
  if [ "$count" -eq 0 ]; then
    echo "ERROR: no managed container found for application_id=$app on $PVE_HOST" >&2
    return 1
  fi
  if [ "$count" -gt 1 ]; then
    echo "ERROR: multiple managed containers found for application_id=$app on $PVE_HOST (VMIDs: $matches) — set previous_vm_id explicitly in the params JSON to disambiguate" >&2
    return 1
  fi
  echo "$matches"
}

# Auto-inject previous_vm_id into the params JSON for upgrade/reconfigure
# tasks when missing. Echoes the (possibly-augmented) params file path —
# caller is responsible for removing the returned file if it differs from
# the input.
augment_params_with_previous_vmid() {
  local input="$1"
  local task
  task=$(grep -oE '"task"[[:space:]]*:[[:space:]]*"[^"]+"' "$input" 2>/dev/null | head -1 | sed -E 's/.*"task"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
  case "$task" in
    upgrade|reconfigure) ;;
    *) echo "$input"; return 0 ;;
  esac
  # Already set in params?
  if grep -q '"name"[[:space:]]*:[[:space:]]*"previous_vm_id"' "$input" 2>/dev/null; then
    echo "$input"; return 0
  fi
  local app
  app=$(grep -oE '"application"[[:space:]]*:[[:space:]]*"[^"]+"' "$input" | head -1 | sed -E 's/.*"application"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
  if [ -z "$app" ]; then echo "$input"; return 0; fi
  local vmid
  if ! vmid=$(resolve_previous_vmid "$app"); then
    # Resolution failed (zero or multiple matches). Pass the input through;
    # the CLI will reject with a clear "previous_vm_id is required" error.
    echo "$input"; return 1
  fi
  echo "  Auto-resolved previous_vm_id=$vmid for $task task" >&2
  local out
  out=$(mktemp)
  if command -v jq >/dev/null 2>&1; then
    jq --argjson v "$vmid" '.params += [{"name":"previous_vm_id","value":$v}]' "$input" > "$out"
  else
    awk -v vmid="$vmid" '
      /"params"[[:space:]]*:[[:space:]]*\[/ {
        sub(/\[/, "[ {\"name\":\"previous_vm_id\",\"value\":" vmid "},")
      }
      { print }
    ' "$input" > "$out"
  fi
  echo "$out"
}

ensure_stack

# Dependency order: postgres → nginx → zitadel → gitea
case "${1:-all}" in
  docker-registry-mirror) deploy_app docker-registry-mirror ;;
  ghcr-registry-mirror)   deploy_app ghcr-registry-mirror ;;
  postgres) deploy_app postgres ;;
  nginx)    deploy_app nginx ;;
  zitadel)  deploy_app postgres; deploy_app zitadel 900 ;;
  gitea)    deploy_app postgres; deploy_app zitadel 900; deploy_app gitea ;;
  eclipse-mosquitto) deploy_app eclipse-mosquitto ;;
  all)
    deploy_app docker-registry-mirror
    deploy_app postgres
    deploy_app nginx
    deploy_app zitadel 900
    deploy_app gitea
    deploy_app eclipse-mosquitto
    ;;
  *.json)
    if [ ! -f "$1" ]; then
      # Try with SCRIPT_DIR prefix
      if [ -f "$SCRIPT_DIR/$1" ]; then
        echo "=== Deploying from $1 ==="
        run_cli "$SCRIPT_DIR/$1" --timeout 600
      else
        echo "ERROR: $1 not found"; exit 1
      fi
    else
      echo "=== Deploying from $1 ==="
      run_cli "$1" --timeout 600
    fi
    ;;
  *) echo "Usage: $0 [docker-registry-mirror|ghcr-registry-mirror|postgres|nginx|zitadel|gitea|eclipse-mosquitto|all|<file.json>]"; exit 1 ;;
esac
