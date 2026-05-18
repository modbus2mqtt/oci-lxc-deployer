#!/bin/sh
# Check that PostgreSQL enforces client-certificate (mTLS) authentication
# when pg_client_cert is enabled.
#
# Template variables:
#   vm_id          - Container VM ID
#   pg_client_cert - "true" when mTLS is expected
#
# Outputs JSON array with the check result on stdout.
# Logs go to stderr. Exit 1 on failure, exit 0 on success/skip.

VM_ID="{{ vm_id }}"
PG_CLIENT_CERT="{{ pg_client_cert }}"

[ "$PG_CLIENT_CERT" = "NOT_DEFINED" ] && PG_CLIENT_CERT="false"

if [ "$PG_CLIENT_CERT" != "true" ]; then
  echo "CHECK: pg_mtls SKIPPED (pg_client_cert=$PG_CLIENT_CERT)" >&2
  printf '[{"id":"check_pg_mtls","value":"skipped"}]'
  exit 0
fi

psql_q() {
  pct exec "$VM_ID" -- su - postgres -c "psql -t -A -c \"$1\"" 2>/dev/null || true
}

FAIL=0

# 1. SSL must be on (precondition for ssl_ca_file).
ssl_status=$(psql_q 'SHOW ssl')
if [ "$ssl_status" = "on" ]; then
  echo "CHECK: pg_mtls ssl=on PASSED" >&2
else
  echo "CHECK: pg_mtls ssl=on FAILED (ssl=$ssl_status)" >&2
  FAIL=1
fi

# 2. ssl_ca_file must point at the CA bundle.
ca_file=$(psql_q 'SHOW ssl_ca_file')
if [ "$ca_file" = "/certs/chain.pem" ]; then
  echo "CHECK: pg_mtls ssl_ca_file PASSED ($ca_file)" >&2
else
  echo "CHECK: pg_mtls ssl_ca_file FAILED (ssl_ca_file=$ca_file)" >&2
  FAIL=1
fi

# 3. pg_hba must have a hostssl rule using the 'cert' auth method ...
hba_cert=$(psql_q "SELECT count(*) FROM pg_hba_file_rules WHERE type='hostssl' AND auth_method='cert'")
if [ -n "$hba_cert" ] && [ "$hba_cert" != "0" ]; then
  echo "CHECK: pg_mtls hostssl-cert rule PASSED (count=$hba_cert)" >&2
else
  echo "CHECK: pg_mtls hostssl-cert rule FAILED (count=$hba_cert)" >&2
  FAIL=1
fi

# 4. ... and NO password/trust rule for plain TCP (cert-only policy active).
hba_pw=$(psql_q "SELECT count(*) FROM pg_hba_file_rules WHERE type IN ('host','hostssl','hostnossl') AND auth_method IN ('scram-sha-256','md5','password','trust')")
if [ "$hba_pw" = "0" ]; then
  echo "CHECK: pg_mtls no-password-TCP PASSED" >&2
else
  echo "CHECK: pg_mtls no-password-TCP FAILED (password/trust TCP rules=$hba_pw)" >&2
  FAIL=1
fi

# 5. Behavioural: a TCP connection without a client certificate must be
#    rejected. We expect this to FAIL; success means the policy is not enforced.
if pct exec "$VM_ID" -- su - postgres -c \
  "psql 'host=127.0.0.1 port=5432 sslmode=require user=postgres dbname=postgres connect_timeout=5' -t -A -c 'SELECT 1'" \
  >/dev/null 2>/dev/null; then
  echo "CHECK: pg_mtls reject-no-cert FAILED (passwordless TCP without cert was accepted)" >&2
  FAIL=1
else
  echo "CHECK: pg_mtls reject-no-cert PASSED (TCP without client cert rejected)" >&2
fi

if [ "$FAIL" -eq 0 ]; then
  printf '[{"id":"check_pg_mtls","value":"on"}]'
  exit 0
fi

printf '[{"id":"check_pg_mtls","value":"off"}]'
exit 1
