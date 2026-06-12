-- Sets/rotates the app_rls login password from a psql variable, so no secret is
-- committed to the repo or baked into a migration. The role itself is created
-- by the 20260612170000_enable_rls_pilot migration.
--
-- Run as the owner/superuser, once per environment and on each rotation:
--   psql "$DATABASE_MIGRATION_URL" -v app_rls_password="$APP_RLS_PASSWORD" -f prisma/rls/app_rls_setup.sql
ALTER ROLE app_rls WITH LOGIN PASSWORD :'app_rls_password';
