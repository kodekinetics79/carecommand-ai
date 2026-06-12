-- RLS Phase B-2 pilot: NotificationTemplate, AiGuardrail, CustomerPreference.
-- Applied by the owner/superuser (DATABASE_MIGRATION_URL). RLS only bites the
-- restricted runtime role `app_rls`; the owner/superuser still bypasses it,
-- which is why migrations and seed remain on the owner role.

-- 1) Restricted runtime role. Created idempotently and WITHOUT a password here;
--    the per-environment secret is applied via prisma/rls/app_rls_setup.sql.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    CREATE ROLE app_rls LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- 2) Runtime privileges. The single-pool app runs entirely as app_rls, so it
--    needs DML on all current tables; RLS is enforced only on the pilot tables
--    below. Default privileges cover tables created by future migrations.
GRANT USAGE ON SCHEMA public TO app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO app_rls;

-- 3) Pilot tenant-isolation policies. FORCE so even a non-superuser owner is
--    subject; the policy fails closed when app.current_tenant_id is unset (NULL).
ALTER TABLE "NotificationTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationTemplate" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "NotificationTemplate";
CREATE POLICY tenant_isolation ON "NotificationTemplate"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "AiGuardrail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiGuardrail" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AiGuardrail";
CREATE POLICY tenant_isolation ON "AiGuardrail"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "CustomerPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerPreference" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CustomerPreference";
CREATE POLICY tenant_isolation ON "CustomerPreference"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
