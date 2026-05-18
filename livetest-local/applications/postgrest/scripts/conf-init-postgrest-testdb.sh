#!/bin/sh
# TEST-ONLY DB init for livetest postgrest scenarios.
# Runs inside the postgres dependency container (execute_on: application:postgres),
# before postgrest starts. Idempotent.
#
# Production proxvex creates NO database SQL — this exists solely so livetest
# postgrest scenarios have a working database (the operator does this in real
# deployments; see json/applications/postgrest/application.md ## Database setup).
#
# Creates:
#   - role `postgrest`  LOGIN   (mTLS cert CN / connection role)
#   - role `web_anon`   NOLOGIN (db_anon_role default)
#   - GRANT web_anon TO postgrest, postgres  (anon switch for mTLS + password)
#   - public.livetest_ping(msg) with one row, SELECT granted to web_anon
#   - pgrst_watch event trigger (schema reload on DDL)

echo "livetest: initializing postgrest test database..." >&2

psql -U postgres -v ON_ERROR_STOP=1 -f - >&2 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgrest') THEN
    CREATE ROLE postgrest LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'web_anon') THEN
    CREATE ROLE web_anon NOLOGIN;
  END IF;
END $$;

GRANT web_anon TO postgrest;
GRANT web_anon TO postgres;

CREATE TABLE IF NOT EXISTS public.livetest_ping (msg text);
INSERT INTO public.livetest_ping (msg)
  SELECT 'pong' WHERE NOT EXISTS (SELECT 1 FROM public.livetest_ping);

GRANT USAGE ON SCHEMA public TO web_anon;
GRANT SELECT ON public.livetest_ping TO web_anon;

CREATE OR REPLACE FUNCTION public.pgrst_watch() RETURNS event_trigger
LANGUAGE plpgsql AS $$
BEGIN
  NOTIFY pgrst, 'reload schema';
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_event_trigger WHERE evtname = 'pgrst_watch') THEN
    CREATE EVENT TRIGGER pgrst_watch ON ddl_command_end
      EXECUTE PROCEDURE public.pgrst_watch();
  END IF;
END $$;
SQL

echo "livetest: postgrest test database ready (role postgrest/web_anon, public.livetest_ping)" >&2
