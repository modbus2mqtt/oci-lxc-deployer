#!/bin/sh
# Ensure a passwordless LOGIN role exists for every mTLS client-cert CN, in
# the postgres dependency container (execute_on: application:postgres).
#
# Why: production postgres is cert-only (pg_hba `cert`) — the client cert CN
# maps to a postgres role of the SAME name, which must exist and be able to
# LOGIN; no password is consulted. addon-mtls is otherwise client-side only
# (it issues the certs + wires the app), so without this the cert-only app
# (e.g. gitea, mtls_cns="<host>\npostgres") connects as role `gitea`, the
# role does not exist, and auth fails → the app container crash-loops.
#
# Scope (per design decision): create the LOGIN role for EVERY mtls_cns CN
# if missing; idempotent. DB ownership / GRANTs stay app-specific and are
# NOT done here. The role is passwordless on purpose — cert-only auth.
# CN `postgres` (zitadel's Admin CN) already exists as the superuser; the
# IF-EXISTS branch just re-asserts LOGIN, harmless.
#
# Safe for non-postgres mTLS apps (e.g. eclipse-mosquitto/MQTT): the
# template guards with skip_if_all_missing:[database_name], so this never
# runs — and thus never tries to resolve a postgres dependency — for apps
# that declare no database.
set -eu

MTLS_CNS="{{ mtls_cns }}"
[ "$MTLS_CNS" = "NOT_DEFINED" ] && MTLS_CNS=""

if [ -z "$MTLS_CNS" ]; then
  echo "mtls_cns empty — no DB roles to ensure, skipping" >&2
  echo '[{"id":"mtls_db_roles","value":"skipped-no-cns"}]'
  exit 0
fi

# CNs may be separated by real newlines (JSON \n in the app property),
# literal backslash-n, or commas — normalize all to newlines.
CN_LIST=$(printf '%s' "$MTLS_CNS" | sed 's/\\n/\n/g; s/,/\n/g')

ensured=""
echo "$CN_LIST" | while IFS= read -r cn; do
  cn=$(printf '%s' "$cn" | tr -d '[:space:]')
  [ -z "$cn" ] && continue
  # Postgres role-name allowlist — makes the direct SQL interpolation below
  # ("$cn" / '$cn') injection-safe (only [A-Za-z0-9_-] reach psql).
  case "$cn" in
    *[!A-Za-z0-9_-]*)
      echo "Skipping invalid mTLS CN '$cn' (not a safe role name)" >&2
      continue
      ;;
  esac
  echo "Ensuring LOGIN role '$cn' (cert-only, no password)..." >&2
  # Check-then-act (mirrors conf-create-postgres-database.sh). No DO block /
  # psql `:var`: psql does NOT interpolate variables inside dollar-quoted
  # ($$…$$) bodies, which broke the earlier DECLARE := :'role' approach.
  # $cn is allowlisted to [A-Za-z0-9_-] above, so interpolating it as a
  # quoted identifier ("$cn") / string literal ('$cn') is injection-safe.
  if [ "$(psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$cn'" 2>/dev/null)" = "1" ]; then
    psql -U postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE \"$cn\" WITH LOGIN" >&2
  else
    psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE \"$cn\" LOGIN" >&2
  fi
done

echo "mTLS DB roles ensured for: $(printf '%s' "$CN_LIST" | tr '\n' ' ')" >&2
echo '[{"id":"mtls_db_roles","value":"ensured"}]'
