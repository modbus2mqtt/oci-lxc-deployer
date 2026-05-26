#!/bin/sh
# PVE Access Control Common Library
#
# Idempotent wrappers around `pveum` for the role/user/token/ACL primitives
# needed by the proxvex scoped-token model:
#
#   pve_acl_role_ensure   <name> <privs-csv>
#   pve_acl_user_ensure   <userid>
#   pve_acl_token_ensure  <userid> <tokenname> [--privsep 0|1]    -> stdout: secret OR empty
#   pve_acl_token_drop    <userid> <tokenname>
#   pve_acl_set           <path> <userid> <role> [--propagate 0|1]
#   pve_acl_user_drop     <userid>
#   pve_acl_role_drop     <name>
#
# All functions:
#  - exit 0 on success (including idempotent no-op), non-zero on real failure
#  - log to stderr only (stdout reserved for the one function that returns the
#    token secret on first creation)
#  - require root on the PVE host (pveum is a root-only CLI)
#
# It contains only function definitions - no direct execution.

# ---------------------------------------------------------------------------
# Role: ensure role exists with the EXACT privilege set. If it already
# exists with a different set, modify it. pveum's `role list` outputs a
# table with privileges in column 2 (comma-separated, alphabetically
# sorted by pveum). We normalize both sides before comparing.
# ---------------------------------------------------------------------------
pve_acl_role_ensure() {
  _pal_name="$1"
  _pal_privs="$2"
  if [ -z "$_pal_name" ] || [ -z "$_pal_privs" ]; then
    echo "pve_acl_role_ensure: missing args (name privs)" >&2
    return 2
  fi

  _pal_want=$(echo "$_pal_privs" | tr ',' '\n' | sort -u | tr '\n' ',' | sed 's/,$//')
  _pal_have=$(pveum role list --output-format json 2>/dev/null \
              | sed -n "s/.*\"roleid\":\"${_pal_name}\"[^}]*\"privs\":\"\\([^\"]*\\)\".*/\\1/p" \
              | head -1)

  if [ -z "$_pal_have" ]; then
    echo "pve_acl: creating role '$_pal_name' with privs=$_pal_want" >&2
    pveum role add "$_pal_name" -privs "$_pal_want" >&2 || return 1
    return 0
  fi

  _pal_have_norm=$(echo "$_pal_have" | tr ',' '\n' | sort -u | tr '\n' ',' | sed 's/,$//')
  if [ "$_pal_have_norm" = "$_pal_want" ]; then
    echo "pve_acl: role '$_pal_name' already at desired privs" >&2
    return 0
  fi
  echo "pve_acl: updating role '$_pal_name' privs from [$_pal_have_norm] to [$_pal_want]" >&2
  pveum role modify "$_pal_name" -privs "$_pal_want" >&2 || return 1
  return 0
}

# ---------------------------------------------------------------------------
# User: ensure user exists. `pveum user add` errors with "already exists"
# on re-runs, which we treat as success.
# ---------------------------------------------------------------------------
pve_acl_user_ensure() {
  _pau_id="$1"
  _pau_comment="${2:-managed by proxvex}"
  if [ -z "$_pau_id" ]; then
    echo "pve_acl_user_ensure: missing userid" >&2
    return 2
  fi
  if pveum user list --output-format json 2>/dev/null \
       | grep -q "\"userid\":\"${_pau_id}\""; then
    echo "pve_acl: user '$_pau_id' already exists" >&2
    return 0
  fi
  echo "pve_acl: creating user '$_pau_id'" >&2
  pveum user add "$_pau_id" --comment "$_pau_comment" >&2 || return 1
  return 0
}

# ---------------------------------------------------------------------------
# Token: ensure a token exists. If it doesn't, create it and print the
# secret on stdout (this is the only chance — pveum doesn't expose it
# again on later runs). If it already exists, print empty stdout and
# return 0; the caller must have stored the secret from the first run.
#
# Optional 3rd arg: --privsep 0 (default) or --privsep 1. Token-only use
# (no separate ACL on the token itself) → privsep=0 keeps the ACL surface
# to the user's single line.
#
# Returns:
#   stdout: <secret> on first creation, empty otherwise
#   exit 0: success or no-op
#   exit 1: pveum failure
# ---------------------------------------------------------------------------
pve_acl_token_ensure() {
  _pat_user="$1"
  _pat_name="$2"
  _pat_privsep="${3:-0}"
  case "$_pat_privsep" in
    --privsep)
      _pat_privsep="$4"
      ;;
  esac
  _pat_privsep="${_pat_privsep:-0}"

  if [ -z "$_pat_user" ] || [ -z "$_pat_name" ]; then
    echo "pve_acl_token_ensure: missing args (user tokenname)" >&2
    return 2
  fi

  # `user token list` (per-user) returns just the metadata; the secret is
  # not retrievable post-creation. We use a probe `token modify` to detect
  # existence — succeeds when the token is there, fails with "no such
  # token" otherwise.
  if pveum user token modify "$_pat_user" "$_pat_name" --privsep "$_pat_privsep" >/dev/null 2>&1; then
    echo "pve_acl: token '$_pat_user!$_pat_name' already exists (privsep refreshed)" >&2
    # No secret to print — caller is expected to have stored it on first run.
    return 0
  fi

  echo "pve_acl: creating token '$_pat_user!$_pat_name' (privsep=$_pat_privsep)" >&2
  _pat_json=$(pveum user token add "$_pat_user" "$_pat_name" \
              --privsep "$_pat_privsep" --output-format json 2>/dev/null) || return 1
  _pat_secret=$(echo "$_pat_json" | sed -n 's/.*"value":"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$_pat_secret" ]; then
    echo "pve_acl: pveum did not return a token secret — output was: $_pat_json" >&2
    return 1
  fi
  printf '%s' "$_pat_secret"
  return 0
}

# ---------------------------------------------------------------------------
# Token: drop. Used for --rotate flows and for cleanup in tests. Idempotent.
# ---------------------------------------------------------------------------
pve_acl_token_drop() {
  _patd_user="$1"
  _patd_name="$2"
  if [ -z "$_patd_user" ] || [ -z "$_patd_name" ]; then
    echo "pve_acl_token_drop: missing args (user tokenname)" >&2
    return 2
  fi
  pveum user token remove "$_patd_user" "$_patd_name" >/dev/null 2>&1 || true
  return 0
}

# ---------------------------------------------------------------------------
# ACL: ensure a (path, user, role) triple is set. pveum acl modify is
# idempotent on its own — re-applying the same triple is a no-op. We
# expose it as a function for symmetry and to centralize the
# propagate-default decision (default 0 = no propagation, smaller blast
# radius; pass --propagate 1 for explicit broader scoping).
# ---------------------------------------------------------------------------
pve_acl_set() {
  _pas_path="$1"
  _pas_user="$2"
  _pas_role="$3"
  _pas_propagate="${4:-0}"
  case "$_pas_propagate" in
    --propagate) _pas_propagate="$5" ;;
  esac
  _pas_propagate="${_pas_propagate:-0}"

  if [ -z "$_pas_path" ] || [ -z "$_pas_user" ] || [ -z "$_pas_role" ]; then
    echo "pve_acl_set: missing args (path user role)" >&2
    return 2
  fi
  echo "pve_acl: ACL $_pas_path -> $_pas_user role=$_pas_role propagate=$_pas_propagate" >&2
  pveum acl modify "$_pas_path" \
    --users "$_pas_user" --roles "$_pas_role" --propagate "$_pas_propagate" >&2 \
    || return 1
  return 0
}

# ---------------------------------------------------------------------------
# Cleanup helpers — used by tests to leave the PVE host in pristine state.
# All idempotent (errors on "doesn't exist" are swallowed).
# ---------------------------------------------------------------------------
pve_acl_user_drop() {
  _paud_id="$1"
  [ -z "$_paud_id" ] && { echo "pve_acl_user_drop: missing userid" >&2; return 2; }
  pveum user delete "$_paud_id" >/dev/null 2>&1 || true
  return 0
}

pve_acl_role_drop() {
  _pard_name="$1"
  [ -z "$_pard_name" ] && { echo "pve_acl_role_drop: missing role name" >&2; return 2; }
  pveum role delete "$_pard_name" >/dev/null 2>&1 || true
  return 0
}

pve_acl_path_drop() {
  # Remove a specific (path, user, role) ACL entry. pveum acl delete
  # without --propagate matches the entry regardless of propagate flag.
  _papd_path="$1"
  _papd_user="$2"
  _papd_role="$3"
  if [ -z "$_papd_path" ] || [ -z "$_papd_user" ] || [ -z "$_papd_role" ]; then
    echo "pve_acl_path_drop: missing args (path user role)" >&2
    return 2
  fi
  pveum acl delete "$_papd_path" --users "$_papd_user" --roles "$_papd_role" >/dev/null 2>&1 || true
  return 0
}
