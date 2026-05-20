#!/bin/bash
# step3-build-snapshot-set.sh
#
# Baut den vordefinierten Satz selbstbeschreibender pct-Snapshots, die als
# Cluster-Baseline für nachfolgende Livetests dienen (Schritt 3b der
# konvergierten Snapshot-Strategie). Jeder Cluster wird über
# `livetest --snapshot <name>` gebaut: voller Livetest-Pipeline-Lauf
# (Debug-Bundle vorhanden, Bootstrap-Diagnose), am Iterations-Ende `pct
# snapshot` der CT-vmids mit selbstbeschreibender Description.
#
# Voraussetzung: nested-VM in einem stabilen post-deployer-installed-State —
# typischerweise direkt nach `step2b-install-deployer.sh` oder nach manuellem
# `--fresh`-Reset. Das Script macht selbst **kein** `qm rollback`; Vollreset
# bleibt explizite Operator-Entscheidung (Lebensdauer-Policy: Snapshots
# leben bis explizit refresht).
#
# Subsequente Livetest-Läufe finden die Snapshots automatisch (`findCovering-
# Snapshot` scannt selbstbeschreibende pct-Descriptions auf den Dep-CT-vmids
# und nutzt den kleinsten covering Snapshot).
#
# Usage:
#   ./e2e/step3-build-snapshot-set.sh [instance] [cluster-name ...]
#
# Default: instance aus DEPLOYER_PORT abgeleitet (3301→yellow, sonst green),
# alle Cluster aus dem Katalog. Optional: einzelne Cluster nachschieben, um
# punktuell zu refreshen, z. B.:
#   ./e2e/step3-build-snapshot-set.sh yellow oidc-base oidc-ssl-base

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# ── Instance-Ableitung ────────────────────────────────────────────────
INSTANCE="${1:-}"
if [ -n "$INSTANCE" ] && [[ "$INSTANCE" =~ ^(green|yellow|github-action)$ ]]; then
  shift
else
  case "${DEPLOYER_PORT:-3201}" in
    3301) INSTANCE=yellow ;;
    *)    INSTANCE=green ;;
  esac
fi

VMID=$(jq -r ".instances.${INSTANCE}.vmId" e2e/config.json)
PORT_OFFSET=$(jq -r ".instances.${INSTANCE}.portOffset" e2e/config.json)
PVE_SSH=$((1022 + PORT_OFFSET))
PORTS_DEPLOYER=$(jq -r '.ports.deployer' e2e/config.json)
DEPLOYER_PORT_DEFAULT=$((PORTS_DEPLOYER + PORT_OFFSET))
export DEPLOYER_PORT="${DEPLOYER_PORT:-$DEPLOYER_PORT_DEFAULT}"

# ── Cluster-Katalog ───────────────────────────────────────────────────
# Format: "<name>|<scenario-csv>". Disjunkte VMIDs zwischen Clustern → können
# ohne `--fresh` zwischen den Builds gemeinsam koexistieren.
ALL_CLUSTERS=(
  "oidc-base|postgres/default,zitadel/default"
  "oidc-ssl-base|postgres/ssl,zitadel/ssl"
  "oidc-mtls-base|postgres/ssl,zitadel/mtls"
  "oidc-mtls-certonly-base|postgres/mtls,zitadel/mtls-certonly"
)

# Selektion: alle oder nur namentlich genannte.
declare -a CLUSTERS=()
if [ $# -eq 0 ]; then
  CLUSTERS=("${ALL_CLUSTERS[@]}")
else
  for want in "$@"; do
    found=""
    for entry in "${ALL_CLUSTERS[@]}"; do
      [ "${entry%%|*}" = "$want" ] && { found="$entry"; break; }
    done
    if [ -z "$found" ]; then
      echo "Unknown cluster '$want'. Known: $(printf '%s ' "${ALL_CLUSTERS[@]%%|*}")" >&2
      exit 2
    fi
    CLUSTERS+=("$found")
  done
fi

LOG="/tmp/step3-build-snapshot-set-${INSTANCE}.log"
: > "$LOG"
echo "[$(date -u +%FT%TZ)] step3 on $INSTANCE (VMID=$VMID, DEPLOYER_PORT=$DEPLOYER_PORT, PVE_SSH=$PVE_SSH)" | tee -a "$LOG"
echo "[$(date -u +%FT%TZ)] Building ${#CLUSTERS[@]} cluster(s): $(printf '%s ' "${CLUSTERS[@]%%|*}")" | tee -a "$LOG"

# ── Spoke-Deployer sicherstellen (Hub-API readiness + start-livetest-deployer.sh) ──
echo "[$(date -u +%FT%TZ)] Ensuring Spoke deployer on :$DEPLOYER_PORT" | tee -a "$LOG"
DEPLOYER_OK=0
for attempt in 1 2 3 4 5; do
  if DEPLOYER_PORT="$DEPLOYER_PORT" ./e2e/start-livetest-deployer.sh "$INSTANCE" >>"$LOG" 2>&1; then
    DEPLOYER_OK=1; break
  fi
  echo "  deployer start attempt $attempt failed — waiting 20s" | tee -a "$LOG"
  sleep 20
done
if [ "$DEPLOYER_OK" != "1" ]; then
  echo "DEPLOYER START FAILED — see $LOG" | tee -a "$LOG" >&2
  exit 3
fi

# ── Build-Schleife ────────────────────────────────────────────────────
declare -a FAILED=()
OVERALL_START=$(date +%s)
for entry in "${CLUSTERS[@]}"; do
  NAME="${entry%%|*}"
  MEMBERS="${entry#*|}"
  echo "" | tee -a "$LOG"
  echo "=== [$(date -u +%FT%TZ)] Building @$NAME from $MEMBERS ===" | tee -a "$LOG"
  PHASE_START=$(date +%s)
  if DEPLOYER_PORT="$DEPLOYER_PORT" npx tsx backend/tests/livetests/src/live-test-runner.mts \
       "$INSTANCE" --snapshot "$NAME" "$MEMBERS" >>"$LOG" 2>&1; then
    PHASE_END=$(date +%s); DUR=$((PHASE_END-PHASE_START))
    printf "[OK] @%s built in %dm%02ds\n" "$NAME" "$((DUR/60))" "$((DUR%60))" | tee -a "$LOG"
  else
    PHASE_END=$(date +%s); DUR=$((PHASE_END-PHASE_START))
    printf "[FAIL] @%s after %dm%02ds — continuing with remaining clusters\n" "$NAME" "$((DUR/60))" "$((DUR%60))" | tee -a "$LOG"
    FAILED+=("$NAME")
  fi
done

OVERALL_END=$(date +%s); TOTAL=$((OVERALL_END-OVERALL_START))
echo "" | tee -a "$LOG"
echo "=== [$(date -u +%FT%TZ)] Summary: ${#CLUSTERS[@]} cluster(s) in ${TOTAL}s ($((TOTAL/60))m$((TOTAL%60))s), ${#FAILED[@]} failed ===" | tee -a "$LOG"

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "Failed: ${FAILED[*]}" | tee -a "$LOG"
  echo ""
  echo "Verify what landed:"
  echo "  ssh -p $PVE_SSH root@ubuntupve 'for v in \$(pct list | awk \"NR>1 {print \\\$1}\"); do echo --- VM \$v ---; pct listsnapshot \$v 2>/dev/null; done'"
  exit 1
fi

echo ""
echo "Verify the snapshot set:"
echo "  ssh -p $PVE_SSH root@ubuntupve 'for v in \$(pct list | awk \"NR>1 {print \\\$1}\"); do echo --- VM \$v ---; pct listsnapshot \$v 2>/dev/null; done'"
